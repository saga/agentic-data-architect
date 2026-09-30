import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { workspaceRoot, writeJsonAtomic } from './workspace.js';

export type GitHubSearchMode = 'only_selected' | 'selected_and_broad';

export interface ImportantDocumentRef {
  id: string;
  title: string;
  reference: string;
}

export interface McpServerSetting {
  name: string;
  version: number;
  enabled: boolean;
  type: 'local' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  tools?: string[];
  /** HTTP headers may reference environment variables as ${NAME}; secret values are never needed in control.json. */
  headers?: Record<string, string>;
}

export interface InvestigationControl {
  schemaVersion: 1;
  version: number;
  updatedAt: string;
  research: {
    githubRepositories: string[];
    githubSearchMode: GitHubSearchMode;
    keywords: string[];
    importantDocuments: ImportantDocumentRef[];
  };
  agent: {
    systemPrompt: {
      version: number;
      content: string;
    };
    skills: Array<{
      name: string;
      version: number;
      sourceHash?: string;
    }>;
    mcpServers: McpServerSetting[];
  };
  history: Array<{
    version: number;
    updatedAt: string;
    reason: string;
    snapshot: Omit<InvestigationControl, 'history'>;
  }>;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: 'user' | 'system';
  action: string;
  summary: string;
  configurationVersion?: number;
  details?: Record<string, unknown>;
}

function controlFile(name: string): string {
  return path.join(workspaceRoot(name), 'control.json');
}

function auditFile(name: string): string {
  return path.join(workspaceRoot(name), 'audit.jsonl');
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

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

async function skillSourceHash(name: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(config.skillsDir, name, 'SKILL.md'));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

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
      systemPrompt: {
        version: 1,
        content: '',
      },
      skills: config.copilotSkills.map((name) => ({ name, version: 1 })),
      mcpServers: [],
    },
  };
}

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
      systemPrompt: { ...control.agent.systemPrompt },
      skills: control.agent.skills.map((item) => ({ ...item })),
      mcpServers: control.agent.mcpServers.map((item) => ({
        ...item,
        ...(item.args ? { args: [...item.args] } : {}),
        ...(item.tools ? { tools: [...item.tools] } : {}),
        ...(item.headers ? { headers: { ...item.headers } } : {}),
      })),
    },
  };
}

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
            }))
            .filter((item) => item.name)
        : defaults.agent.skills,
      mcpServers: normalizeMcpServers(agent.mcpServers),
    },
  } as Omit<InvestigationControl, 'history'>;

  return {
    ...base,
    history: Array.isArray(raw.history)
      ? raw.history.filter((item): item is InvestigationControl['history'][number] => Boolean(item) && typeof item === 'object')
      : [],
  };
}

export async function loadInvestigationControl(name: string): Promise<InvestigationControl> {
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
}

export async function updateInvestigationControl(
  name: string,
  next: Pick<InvestigationControl, 'research' | 'agent'>,
  reason = 'configuration updated',
): Promise<InvestigationControl> {
  const current = await loadInvestigationControl(name);
  const now = new Date().toISOString();

  const nextSkills = await Promise.all(next.agent.skills
    .map(async (item) => {
      const old = current.agent.skills.find((candidate) => candidate.name === item.name);
      const sourceHash = await skillSourceHash(item.name);
      const changed = Boolean(old && old.sourceHash && sourceHash && old.sourceHash !== sourceHash);
      return {
        name: item.name.trim(),
        version: old ? old.version + (changed ? 1 : 0) : 1,
        ...(sourceHash ? { sourceHash } : {}),
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
    },
  });

  return control;
}

export async function appendAuditEvent(
  name: string,
  event: Omit<AuditEvent, 'id' | 'timestamp'>,
): Promise<AuditEvent> {
  const full: AuditEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };
  await fs.appendFile(auditFile(name), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

export async function readAuditEvents(name: string, limit = 50): Promise<AuditEvent[]> {
  try {
    const text = await fs.readFile(auditFile(name), 'utf8');
    const rows = text.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 500)));
    return rows.reverse().map((row) => JSON.parse(row) as AuditEvent);
  } catch {
    return [];
  }
}

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

function resolveEnvReferences(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '');
}

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
