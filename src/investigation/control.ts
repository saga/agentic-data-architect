/**
 * Investigation Control、版本和审计。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
function normalizeAvatarDimension(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

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

/** 创建一个新 Investigation 的默认配置。技能由 Copilot 根据当前任务自动发现。 */
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
      model: config.model,
      // 本地单用户工作台默认不逐次弹权限确认；需要严格审批时可显式切回 permission。
      permissionMode: 'allow_all',
      autoContinuationTurns: 4,
      displayName: '秘书',
      personality: '温柔、亲近、俏皮，偶尔带一点小小的调侃和撒娇。说话自然，有人的温度，但不要为了卖萌影响结论的准确性。',
      avatarWidth: 180,
      avatarHeight: 240,
      avatarSources: [],
      platformCapabilities: config.graphifyEnabled ? [{ name: 'graphify-structural-analysis', version: config.graphifyPlatformCapabilityVersion, enabled: true }] : [],
      systemPrompt: {
        version: 1,
        content: '',
      },
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
      model: control.agent.model,
      ...(control.agent.autoTier ? { autoTier: control.agent.autoTier } : {}),
      permissionMode: control.agent.permissionMode,
      autoContinuationTurns: control.agent.autoContinuationTurns,
      displayName: control.agent.displayName,
      personality: control.agent.personality,
      ...(control.agent.avatarPath ? { avatarPath: control.agent.avatarPath } : {}),
      ...(control.agent.avatarPaths?.length ? { avatarPaths: [...control.agent.avatarPaths] } : {}),
      ...(control.agent.avatarSources?.length ? { avatarSources: control.agent.avatarSources.map((item) => ({ ...item })) } : {}),
      ...(control.agent.avatarMimeType ? { avatarMimeType: control.agent.avatarMimeType } : {}),
      avatarWidth: control.agent.avatarWidth,
      avatarHeight: control.agent.avatarHeight,
      platformCapabilities: control.agent.platformCapabilities.map((item) => ({ ...item })),
      systemPrompt: { ...control.agent.systemPrompt },
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
export function normalizeControl(raw: Partial<InvestigationControl>): InvestigationControl {
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
      model: typeof agent.model === 'string' && agent.model.trim() ? agent.model.trim().slice(0, 200) : defaults.agent.model,
      ...(agent.autoTier === 'efficiency' || agent.autoTier === 'balance' || agent.autoTier === 'intelligence' || agent.autoTier === 'fast'
        ? { autoTier: agent.autoTier }
        : {}),
      permissionMode: (agent.permissionMode ?? defaults.agent.permissionMode) === 'allow_all' ? 'allow_all' : 'permission',
      autoContinuationTurns: normalizeAvatarDimension(agent.autoContinuationTurns, 4, 0, 6),
      displayName: typeof agent.displayName === 'string' && agent.displayName.trim()
        ? agent.displayName.trim().slice(0, 40)
        : '秘书',
      personality: typeof agent.personality === 'string' ? agent.personality.slice(0, 4000) : defaults.agent.personality,
      ...(typeof agent.avatarPath === 'string' && agent.avatarPath.trim()
        ? { avatarPath: agent.avatarPath.trim() }
        : {}),
      ...(Array.isArray(agent.avatarPaths)
        ? { avatarPaths: [...new Set(agent.avatarPaths.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))] }
        : agent.avatarPath ? { avatarPaths: [agent.avatarPath] } : {}),
      ...(Array.isArray(agent.avatarSources)
        ? {
            avatarSources: agent.avatarSources
              .filter((item) => Boolean(item) && typeof item === 'object')
              .map((item) => {
                const source = item as unknown as Record<string, unknown>;
                return {
                  src: String(source.src ?? '').trim(),
                  kind: source.kind === 'image' || source.kind === 'video' || source.kind === 'remote' ? source.kind : 'remote',
                  ...(typeof source.mimeType === 'string' && source.mimeType.trim() ? { mimeType: source.mimeType.trim() } : {}),
                };
              })
              .filter((item) => item.src),
          }
        : {}),
      ...(agent.avatarMimeType ? { avatarMimeType: String(agent.avatarMimeType).trim() } : {}),
      avatarWidth: normalizeAvatarDimension(agent.avatarWidth, 180, 40, 800),
      avatarHeight: normalizeAvatarDimension(agent.avatarHeight, 240, 40, 1200),
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
      mcpServers: normalizeMcpServers(agent.mcpServers),
    },
  } as Omit<InvestigationControl, 'history'>;

  // 旧版配置可能只有 avatarPaths，没有 avatarPath。默认头像应该直接使用第一张已上传图片。
  if (!base.agent.avatarPath && base.agent.avatarPaths?.length) {
    base.agent.avatarPath = base.agent.avatarPaths[0];
  }

  return InvestigationControlSchema.parse({
    ...base,
    history: Array.isArray(raw.history)
      ? raw.history
          .filter((item): item is InvestigationControl['history'][number] => Boolean(item) && typeof item === 'object')
          .map((item) => {
            // Skill configuration used to live inside each historical Agent snapshot.
            // Strip that obsolete field while preserving the rest of the historical record.
            const snapshot = item.snapshot as unknown as Record<string, unknown>;
            const snapshotAgent = snapshot?.agent;
            if (snapshotAgent && typeof snapshotAgent === 'object' && !Array.isArray(snapshotAgent)) {
              const agentRecord = snapshotAgent as Record<string, unknown>;
              // 兼容权限模式字段加入前生成的旧历史快照。
              const { skills: _skills, ...agentWithoutSkills } = agentRecord;
              return {
                ...item,
                snapshot: {
                  ...snapshot,
                  agent: {
                    ...agentWithoutSkills,
                    permissionMode: (agentRecord.permissionMode ?? base.agent.permissionMode) === 'allow_all' ? 'allow_all' : 'permission',
                  },
                },
              };
            }
            return item;
          })
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

/** 串行更新 Research/Agent 配置、递增版本、记录调查说明和 MCP 变化并写审计。 */
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
      model: next.agent.model.trim().slice(0, 200),
      ...(next.agent.autoTier ? { autoTier: next.agent.autoTier } : {}),
      permissionMode: next.agent.permissionMode,
      autoContinuationTurns: normalizeAvatarDimension(next.agent.autoContinuationTurns, current.agent.autoContinuationTurns, 0, 6),
      displayName: next.agent.displayName.trim().slice(0, 40),
      personality: next.agent.personality.slice(0, 4000),
      ...(next.agent.avatarPath ? { avatarPath: next.agent.avatarPath } : {}),
      ...(next.agent.avatarPaths?.length ? { avatarPaths: [...next.agent.avatarPaths] } : {}),
      ...(next.agent.avatarSources?.length ? { avatarSources: next.agent.avatarSources.map((item) => ({ ...item })) } : {}),
      ...(next.agent.avatarMimeType ? { avatarMimeType: next.agent.avatarMimeType } : {}),
      avatarWidth: normalizeAvatarDimension(next.agent.avatarWidth, current.agent.avatarWidth, 40, 800),
      avatarHeight: normalizeAvatarDimension(next.agent.avatarHeight, current.agent.avatarHeight, 40, 1200),
      // Platform capabilities are controlled by the application, not the per-Investigation UI.
      // Custom MCP servers remain user-configurable for this Investigation.
      platformCapabilities: current.agent.platformCapabilities.map((item) => ({ ...item })),
      systemPrompt: {
        version: promptChanged ? current.agent.systemPrompt.version + 1 : current.agent.systemPrompt.version,
        content: next.agent.systemPrompt.content,
      },
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
  if (promptChanged) changed.push('guidance');
  if (JSON.stringify(current.agent.mcpServers) !== JSON.stringify(control.agent.mcpServers)) changed.push('mcp');
  if (current.agent.model !== control.agent.model) changed.push('model');
  if (current.agent.autoTier !== control.agent.autoTier) changed.push('autoTier');
  if (current.agent.permissionMode !== control.agent.permissionMode) changed.push('permission');
  if (current.agent.autoContinuationTurns !== control.agent.autoContinuationTurns) changed.push('autoContinuation');
  if (current.agent.displayName !== control.agent.displayName) changed.push('displayName');
  if (
    current.agent.avatarPath !== control.agent.avatarPath
    || current.agent.avatarMimeType !== control.agent.avatarMimeType
    || current.agent.avatarWidth !== control.agent.avatarWidth
    || current.agent.avatarHeight !== control.agent.avatarHeight
  ) changed.push('avatar');

  await appendAuditEvent(name, {
    actor: 'user',
    action: 'configuration.updated',
    summary: 'Updated investigation configuration: ' + (changed.join(', ') || 'no semantic changes'),
    configurationVersion: control.version,
    details: {
      changed,
      guidanceVersion: control.agent.systemPrompt.version,
      model: control.agent.model,
      ...(control.agent.autoTier ? { autoTier: control.agent.autoTier } : {}),
      permissionMode: control.agent.permissionMode,
      autoContinuationTurns: control.agent.autoContinuationTurns,
      displayName: control.agent.displayName,
      avatar: {
        configured: Boolean(control.agent.avatarPath),
        width: control.agent.avatarWidth,
        height: control.agent.avatarHeight,
      },
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
    'Automatic continuation is controlled by the UI setting; when enabled, use extra stages to advance the overall investigation rather than repeat a blocked small step.',
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
    lines.push('Additional investigation guidance:');
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
