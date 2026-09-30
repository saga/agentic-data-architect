import { CopilotClient } from '@github/copilot-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

let client: CopilotClient | null = null;
let starting: Promise<CopilotClient> | null = null;

const SESSION_NOT_FOUND = /session not found|no such session|unknown session|does not exist|has been deleted/i;
const TURN_TIMEOUT = /^Timeout after \d+ms waiting for session\.idle$/;

export async function getClient(): Promise<CopilotClient> {
  if (client) return client;
  if (starting) return starting;
  starting = (async () => {
    const c = config.githubToken
      ? new CopilotClient({ mode: 'empty', gitHubToken: config.githubToken, useLoggedInUser: false })
      : new CopilotClient({ mode: 'copilot-cli', useLoggedInUser: true });
    await c.start();
    client = c;
    starting = null;
    return c;
  })().catch((e) => {
    starting = null;
    throw e;
  });
  return starting;
}

export async function stopClient(): Promise<void> {
  starting = null;
  if (client) {
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
    client = null;
  }
}

type CreateSessionConfig = Parameters<CopilotClient['createSession']>[0];

export interface AskInput {
  prompt: string;
  systemPrompt: string;
  /** When provided, the same resumable Copilot session is reused across turns/processes. */
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  skills?: string[];
  skillDirectories?: string[];
  mcpServers?: NonNullable<CreateSessionConfig['mcpServers']>;
  onDelta?: (delta: string) => void;
  onStatus?: (status: string) => void;
  onSessionId?: (sessionId: string) => void;
  turnId?: string;
  shouldAbort?: () => boolean;
}

const activeSessions = new Map<string, { sessionId: string; abort: () => Promise<void> }>();

async function listSkillNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const skillFile = await fs.readFile(path.join(config.skillsDir, entry.name, 'SKILL.md'), 'utf8');
        const name = /^name:\s*(.+)$/m.exec(skillFile)?.[1]?.trim() || entry.name;
        if (name) names.push(name);
      } catch {
        // Ignore invalid skill directories; the SDK will not load them either.
      }
    }
    return [...new Set(names)];
  } catch {
    return [];
  }
}

export function hasActiveCopilotTurn(turnId: string): boolean {
  return activeSessions.has(turnId);
}

export async function abortCopilotTurn(turnId: string): Promise<boolean> {
  const active = activeSessions.get(turnId);
  if (!active) return false;
  try {
    await active.abort();
    return true;
  } catch {
    return false;
  }
}

export async function askCopilot(input: AskInput): Promise<string> {
  const c = await getClient();

  // This application intentionally uses Copilot's default agent. The project
  // config controls reusable Skills; custom agents are only needed when we
  // introduce genuinely different agent roles.
  const availableSkillNames = await listSkillNames();
  const selectedSkillNames = new Set(input.skills ?? config.copilotSkills);
  const disabledSkills = availableSkillNames.filter((name) => !selectedSkillNames.has(name));

  const sessionConfig: CreateSessionConfig = {
    model: input.model ?? config.model,
    workingDirectory: input.workingDirectory ?? process.cwd(),
    systemMessage: { mode: 'append' as const, content: input.systemPrompt },
    skillDirectories: input.skillDirectories ?? [config.skillsDir],
    disabledSkills,
    ...(input.mcpServers && Object.keys(input.mcpServers).length ? { mcpServers: input.mcpServers } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  // A Copilot session is runtime context only. Investigation state and turn
  // lifecycle remain owned by our workspace/SQLite layers.
  const session = input.sessionId
    ? await resumeOrCreate(c, input.sessionId, sessionConfig)
    : await c.createSession(sessionConfig);

  input.onSessionId?.(session.sessionId);
  if (input.turnId) {
    activeSessions.set(input.turnId, { sessionId: session.sessionId, abort: () => session.abort() });
  }
  try {
    if (input.shouldAbort?.()) {
      await session.abort();
      throw new Error('Turn aborted.');
    }
    await session.rpc.skills.reload();
  } catch {
    // Skill reload is best-effort; session creation still works on older runtimes.
  }

  let content = '';
  const offMessageDelta = session.on('assistant.message_delta', (e) => {
    if (e.data.deltaContent) {
      content += e.data.deltaContent;
      input.onDelta?.(e.data.deltaContent);
    }
  });
  const offIntent = session.on('assistant.intent', (e) => {
    const intent = typeof e.data.intent === 'string' ? e.data.intent.trim() : '';
    if (intent) input.onStatus?.(intent);
  });
  const offReasoning = session.on('assistant.reasoning_delta', () => {
    input.onStatus?.('Thinking…');
  });
  const offToolStart = session.on('tool.execution_start', (e) => {
    const toolName = typeof e.data.toolName === 'string' ? e.data.toolName.trim() : '';
    input.onStatus?.(toolName ? `Running ${toolName}…` : 'Running a tool…');
  });
  const offToolComplete = session.on('tool.execution_complete', () => {
    input.onStatus?.('Thinking…');
  });
  // These events are UI status signals, not model chain-of-thought. Keep them
  // operational so the browser never receives hidden reasoning text.
  const offPermission = session.on('permission.requested', () => {
    input.onStatus?.('Waiting for approval…');
  });
  const offCompaction = session.on('session.compaction_start', () => {
    input.onStatus?.('Summarizing context…');
  });
  try {
    if (input.shouldAbort?.()) {
      await session.abort();
      throw new Error('Turn aborted.');
    }
    const final = await session.sendAndWait({ prompt: input.prompt }, config.turnTimeoutMs);
    return final?.data.content || content;
  } catch (e) {
    if (e instanceof Error && TURN_TIMEOUT.test(e.message)) {
      try {
        await session.abort();
      } catch {
        /* ignore */
      }
    }
    throw e;
  } finally {
    if (input.turnId) activeSessions.delete(input.turnId);
    offMessageDelta();
    offIntent();
    offReasoning();
    offToolStart();
    offToolComplete();
    offPermission();
    offCompaction();
    try {
      await session.disconnect();
    } catch {
      /* ignore */
    }
  }
}

async function resumeOrCreate(
  c: CopilotClient,
  sessionId: string,
  sessionConfig: Parameters<CopilotClient['createSession']>[0],
) {
  try {
    return await c.resumeSession(sessionId, sessionConfig);
  } catch (e) {
    if (e instanceof Error && SESSION_NOT_FOUND.test(e.message)) {
      return c.createSession(sessionConfig);
    }
    try {
      if ((await c.getSessionMetadata(sessionId)) === undefined) {
        return c.createSession(sessionConfig);
      }
    } catch {
      /* preserve the original resume error */
    }
    throw e;
  }
}
