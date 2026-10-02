/**
 * Investigation Control、版本和审计。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { workspaceRoot, writeJsonAtomic } from './workspace.js';
import {
  AuditEventSchema,
  InvestigationControlSchema,
  McpServerSettingSchema,
  type AuditEvent,
  type ImportantDocumentRef,
  type InvestigationControl,
  type McpServerSetting,
} from './schemas.js';

/** 返回当前 Investigation 的 control.json 路径。 */
function controlFile(name: string): string {
  return path.join(workspaceRoot(name), 'control.json');
}

const controlUpdateLocks = new Map<string, Promise<void>>();
const controlInitLocks = new Map<string, Promise<void>>();
const WORKFLOW_SKILL_NAMES = new Set(['legacy-modernization', 'financial-ai-native-architecture', 'data-architecture-assessment']);


/** 将同一 Investigation 的配置更新串行化，避免多个请求互相覆盖版本。 */
async function withControlUpdateLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = controlUpdateLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  controlUpdateLocks.set(name, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (controlUpdateLocks.get(name) === queued) controlUpdateLocks.delete(name);
  }
}

/** 返回当前 Investigation 的审计日志路径。 */
function auditFile(name: string): string {
  return path.join(workspaceRoot(name), 'audit.jsonl');
}

/** 清理字符串数组：去空格、去空值、去重复，为配置保存提供稳定输入。 */
function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

/** 将历史/外部传入的 MCP 配置归一化成内部结构，再交给 Zod 做最终验证。 */
function normalizeMcpServers(value: unknown): McpServerSetting[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? '').trim(),
      version: Number(item.version ?? 1) || 1,
      enabled: item.enabled !== false,
      type: (item.type === 'http' ? 'http' : 'local') as McpServerSetting['type'],
      ...(typeof item.command === 'string' && item.command.trim() ? { command: item.command.trim() } : {}),
      ...(Array.isArray(item.args) ? { args: item.args.filter((arg): arg is string => typeof arg === 'string') } : {}),
      ...(typeof item.url === 'string' && item.url.trim() ? { url: item.url.trim() } : {}),
      ...(Array.isArray(item.tools) ? { tools: item.tools.filter((tool): tool is string => typeof tool === 'string') } : {}),
      ...(item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
        ? { headers: Object.fromEntries(Object.entries(item.headers).filter(([key, value]) => typeof key === 'string' && typeof value === 'string')) }
        : {}),
    }))
    .filter((item) => item.name);
}

/**
 * Hash every file in a Skill bundle, not only SKILL.md.
 * A change to a deterministic script/reference must create a new Skill version too.
 */
async function skillSourceHash(name: string): Promise<string | undefined> {
  const root = path.join(config.skillsDir, name);
  try {
    const files: string[] = [];

    const visit = async (directory: string, relative = ''): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const nextRelative = path.join(relative, entry.name);
        const nextAbsolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(nextAbsolute, nextRelative);
        } else if (entry.isFile()) {
          files.push(nextRelative);
        }
      }
    };

    await visit(root);
    files.sort();

    const hash = createHash('sha256');
    for (const relative of files) {
      hash.update(relative);
      hash.update('\0');
      hash.update(await fs.readFile(path.join(root, relative)));
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/** 创建一个新 Investigation 的默认配置，默认 Skill 来自环境配置。 */
function defaultControl(): Omit<InvestigationControl, 'history'> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: now,
    research: {
      githubRepositories: [],
      githubSearchMode: 'only_selected',
      keywords: [],
      importantDocuments: [],
    },
    agent: {
      platformCapabilities: config.graphifyEnabled ? [{ name: 'graphify-structural-analysis', version: config.graphifyPlatformCapabilityVersion, enabled: true }] : [],
      systemPrompt: {
        version: 1,
        content: '',
      },
      skills: config.copilotSkills.filter((name) => !WORKFLOW_SKILL_NAMES.has(name)).map((name) => ({ name, version: 1 })),
      mcpServers: [],
    },
  };
}

/** 复制当前配置到 history 快照，避免后续对象修改影响历史记录。 */
function snapshotOf(control: InvestigationControl): Omit<InvestigationControl, 'history'> {
  return {
    schemaVersion: control.schemaVersion,
    version: control.version,
    updatedAt: control.updatedAt,
    research: {
      githubRepositories: [...control.research.githubRepositories],
      githubSearchMode: control.research.githubSearchMode,
      keywords: [...control.research.keywords],
      importantDocuments: control.research.importantDocuments.map((item) => ({ ...item })),
    },
    agent: {
      platformCapabilities: control.agent.platformCapabilities.map((item) => ({ ...item })),
      systemPrompt: { ...control.agent.systemPrompt },
      skills: control.agent.skills.map((item) => ({ ...item, parameters: { ...(item.parameters ?? {}) } })),
      mcpServers: control.agent.mcpServers.map((item) => ({
        ...item,
        ...(item.args ? { args: [...item.args] } : {}),
        ...(item.tools ? { tools: [...item.tools] } : {}),
        ...(item.headers ? { headers: { ...item.headers } } : {}),
      })),
    },
  };
}

/** 读取旧 control.json 后补默认值、清理历史格式，并通过 Zod 得到可信 Control。 */
function normalizeControl(raw: Partial<InvestigationControl>): InvestigationControl {
  const defaults = defaultControl();
  const research = raw.research ?? defaults.research;
  const agent = raw.agent ?? defaults.agent;
  const base = {
    schemaVersion: 1,
    version: Number(raw.version ?? 1) || 1,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    research: {
      githubRepositories: normalizeStringList(research.githubRepositories),
      githubSearchMode: research.githubSearchMode === 'selected_and_broad' ? 'selected_and_broad' as const : 'only_selected' as const,
      keywords: normalizeStringList(research.keywords),
      importantDocuments: Array.isArray(research.importantDocuments)
        ? research.importantDocuments
            .filter((item): item is ImportantDocumentRef => Boolean(item) && typeof item === 'object')
            .map((item) => ({
              id: String(item.id ?? randomUUID()),
              title: String(item.title ?? '').trim(),
              reference: String(item.reference ?? '').trim(),
            }))
            .filter((item) => item.title && item.reference)
        : [],
    },
    agent: {
      platformCapabilities: config.graphifyEnabled
        ? [{
            name: 'graphify-structural-analysis',
            version: config.graphifyPlatformCapabilityVersion,
            enabled: true,
          }]
        : [],
      systemPrompt: {
        version: Number(agent.systemPrompt?.version ?? 1) || 1,
        content: typeof agent.systemPrompt?.content === 'string' ? agent.systemPrompt.content : '',
      },
      skills: Array.isArray(agent.skills)
        ? agent.skills
            .map((item) => ({
              name: String(item.name ?? '').trim(),
              version: Number(item.version ?? 1) || 1,
              ...(typeof (item as { sourceHash?: unknown }).sourceHash === 'string'
                ? { sourceHash: (item as { sourceHash: string }).sourceHash }
                : {}),
              parameters: item && typeof item === 'object' && (item as { parameters?: unknown }).parameters
                && typeof (item as { parameters?: unknown }).parameters === 'object'
                && !Array.isArray((item as { parameters?: unknown }).parameters)
                ? { ...((item as { parameters: Record<string, unknown> }).parameters) }
                : {},
            }))
            .filter((item) => item.name && !WORKFLOW_SKILL_NAMES.has(item.name))
        : defaults.agent.skills,
      mcpServers: normalizeMcpServers(agent.mcpServers),
    },
  } as Omit<InvestigationControl, 'history'>;

  return InvestigationControlSchema.parse({
    ...base,
    history: Array.isArray(raw.history)
      ? raw.history.filter((item): item is InvestigationControl['history'][number] => Boolean(item) && typeof item === 'object')
      : [],
  });
}

/** 读取 Control；首次访问时负责创建 v1 默认配置，并用初始化锁避免并发重复创建。 */
export async function loadInvestigationControl(name: string): Promise<InvestigationControl> {
  try {
    return normalizeControl(JSON.parse(await fs.readFile(controlFile(name), 'utf8')) as Partial<InvestigationControl>);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // First access can race with another request. Re-check after serialization so
  // both requests observe the same version-1 control file and audit event.
  const previous = controlInitLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  controlInitLocks.set(name, queued);
  await previous.catch(() => undefined);

  try {
    try {
      return normalizeControl(JSON.parse(await fs.readFile(controlFile(name), 'utf8')) as Partial<InvestigationControl>);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const base = defaultControl();
    const control: InvestigationControl = {
      ...base,
      history: [{
        version: 1,
        updatedAt: base.updatedAt,
        reason: 'initial',
        snapshot: base,
      }],
    };
    await writeJsonAtomic(controlFile(name), control);
    await appendAuditEvent(name, {
      actor: 'system',
      action: 'configuration.created',
      summary: 'Created default investigation configuration.',
      configurationVersion: 1,
    });
    return control;
  } finally {
    release();
    if (controlInitLocks.get(name) === queued) controlInitLocks.delete(name);
  }
}

/** 串行更新 Research/Agent 配置、递增版本、记录 Skill/MCP 版本变化并写审计。 */
export async function updateInvestigationControl(
  name: string,
  next: Pick<InvestigationControl, 'research' | 'agent'>,
  reason = 'configuration updated',
): Promise<InvestigationControl> {
  return withControlUpdateLock(name, () =>
    updateInvestigationControlImpl(name, next, reason),
  );
}

async function updateInvestigationControlImpl(
  name: string,
  next: Pick<InvestigationControl, 'research' | 'agent'>,
  reason = 'configuration updated',
): Promise<InvestigationControl> {
  const current = await loadInvestigationControl(name);
  const now = new Date().toISOString();

  // Skill version is tied to the complete bundle hash, so scripts/references
  // cannot change underneath a configuration version without being recorded.
  const nextSkills = await Promise.all(next.agent.skills
    .map(async (item) => {
      const old = current.agent.skills.find((candidate) => candidate.name === item.name);
      const sourceHash = await skillSourceHash(item.name);
      const changed = Boolean(old && old.sourceHash && sourceHash && old.sourceHash !== sourceHash);
      return {
        name: item.name.trim(),
        version: old ? old.version + (changed ? 1 : 0) : 1,
        ...(sourceHash ? { sourceHash } : {}),
        parameters: { ...(item.parameters ?? {}) },
      };
    }))
    .then((items) => items.filter((item) => item.name));

  const currentMcp = new Map(current.agent.mcpServers.map((item) => [item.name, item]));
  const nextMcp = normalizeMcpServers(next.agent.mcpServers).map((item) => {
    const old = currentMcp.get(item.name);
    if (!old) return { ...item, version: 1 };
    const { version: _version, ...oldComparable } = old;
    const { version: _nextVersion, ...nextComparable } = item;
    return {
      ...item,
      version: JSON.stringify(oldComparable) === JSON.stringify(nextComparable) ? old.version : old.version + 1,
    };
  });

  const promptChanged = current.agent.systemPrompt.content !== next.agent.systemPrompt.content;
  const control: InvestigationControl = {
    schemaVersion: 1,
    version: current.version + 1,
    updatedAt: now,
    research: {
      githubRepositories: normalizeStringList(next.research.githubRepositories),
      githubSearchMode: next.research.githubSearchMode,
      keywords: normalizeStringList(next.research.keywords),
      importantDocuments: next.research.importantDocuments.map((item) => ({
        id: item.id || randomUUID(),
        title: item.title.trim(),
        reference: item.reference.trim(),
      })).filter((item) => item.title && item.reference),
    },
    agent: {
      // Platform capabilities are controlled by the application, not the per-Investigation UI.
      // Preserve the current fixed snapshot while Skills/MCP remain user-configurable.
      platformCapabilities: current.agent.platformCapabilities.map((item) => ({ ...item })),
      systemPrompt: {
        version: promptChanged ? current.agent.systemPrompt.version + 1 : current.agent.systemPrompt.version,
        content: next.agent.systemPrompt.content,
      },
      skills: nextSkills,
      mcpServers: nextMcp,
    },
    history: [],
  };

  control.history = [
    ...current.history,
    {
      version: control.version,
      updatedAt: now,
      reason,
      snapshot: snapshotOf(control),
    },
  ].slice(-30);

  await writeJsonAtomic(controlFile(name), control);

  const changed: string[] = [];
  if (JSON.stringify(current.research) !== JSON.stringify(control.research)) changed.push('research');
  if (promptChanged) changed.push('systemPrompt');
  if (JSON.stringify(current.agent.skills) !== JSON.stringify(control.agent.skills)) changed.push('skills');
  if (JSON.stringify(current.agent.mcpServers) !== JSON.stringify(control.agent.mcpServers)) changed.push('mcp');

  await appendAuditEvent(name, {
    actor: 'user',
    action: 'configuration.updated',
    summary: 'Updated investigation configuration: ' + (changed.join(', ') || 'no semantic changes'),
    configurationVersion: control.version,
    details: {
      changed,
      promptVersion: control.agent.systemPrompt.version,
      skillVersions: Object.fromEntries(control.agent.skills.map((item) => [item.name, item.version])),
      mcpVersions: Object.fromEntries(control.agent.mcpServers.map((item) => [item.name, item.version])),
      platformCapabilities: control.agent.platformCapabilities.map((item) => ({ ...item })),
    },
  });

  return control;
}

/** 向 audit.jsonl 追加一条经过 Schema 校验的审计事件。 */
export async function appendAuditEvent(
  name: string,
  event: Omit<AuditEvent, 'id' | 'timestamp'>,
): Promise<AuditEvent> {
  const full = AuditEventSchema.parse({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  });
  await fs.appendFile(auditFile(name), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

/** 读取最近的审计事件；损坏或不符合当前 Schema 的行会被忽略。 */
export async function readAuditEvents(name: string, limit = 50): Promise<AuditEvent[]> {
  try {
    const text = await fs.readFile(auditFile(name), 'utf8');
    const rows = text.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 500)));
    return rows.reverse()
      .map((row) => AuditEventSchema.safeParse(JSON.parse(row)))
      .filter((result): result is { success: true; data: AuditEvent } => result.success)
      .map((result) => result.data);
  } catch {
    return [];
  }
}

/** 把用户配置转换成模型可读的任务约束 Prompt，并明确它不是 Evidence。 */
export function buildResearchConfigPrompt(control: InvestigationControl): string {
  const lines = [
    '## Investigation configuration',
    'Treat this configuration as user-provided task constraints, not as evidence.',
  ];

  if (control.research.githubRepositories.length) {
    lines.push(
      'GitHub repositories: ' +
        control.research.githubRepositories.join(', ') +
        '. Search mode: ' +
        (control.research.githubSearchMode === 'only_selected' ? 'only these repositories' : 'these repositories first, then broader GitHub search if necessary') +
        '.',
    );
  } else {
    lines.push(
      'GitHub repositories: none configured. Search mode: ' +
        (control.research.githubSearchMode === 'only_selected' ? 'do not broaden beyond explicitly configured repositories' : 'broader GitHub search is allowed') +
        '.',
    );
  }

  if (control.research.keywords.length) {
    lines.push('Research keywords: ' + control.research.keywords.join(', ') + '.');
  }

  if (control.research.importantDocuments.length) {
    lines.push(
      'Important documents: ' +
        control.research.importantDocuments.map((item) => item.title + ' (' + item.reference + ')').join('; ') +
        '.',
    );
  }

  if (control.agent.systemPrompt.content.trim()) {
    lines.push('Additional system guidance:');
    lines.push(control.agent.systemPrompt.content.trim());
  }

  return lines.join('\n');
}

/** 解析 MCP URL/header/command 中的 ${ENV_NAME} 引用，但不把原始敏感变量写回配置。 */
function resolveEnvReferences(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '');
}

/** 将内部 MCP 配置转换成 Copilot SDK 需要的结构，并保留 HTTP headers。 */
export function toCopilotMcpServers(control: InvestigationControl): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const server of control.agent.mcpServers) {
    if (!server.enabled) continue;
    const headers = server.headers
      ? Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, resolveEnvReferences(value)]))
      : undefined;
    if (server.type === 'http' && server.url) {
      result[server.name] = {
        type: 'http',
        url: resolveEnvReferences(server.url),
        tools: server.tools?.length ? server.tools : ['*'],
        ...(headers ? { headers } : {}),
      };
    } else if (server.type === 'local' && server.command) {
      result[server.name] = {
        type: 'local',
        command: resolveEnvReferences(server.command),
        args: (server.args ?? []).map(resolveEnvReferences),
        tools: server.tools?.length ? server.tools : ['*'],
        ...(headers ? { headers } : {}),
      };
    }
  }
  return result;
}
