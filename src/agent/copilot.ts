import { CopilotClient } from '@github/copilot-sdk';
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
  onSessionId?: (sessionId: string) => void;
  turnId?: string;
  shouldAbort?: () => boolean;
}

const activeSessions = new Map<string, { sessionId: string; abort: () => Promise<void> }>();

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
  const sessionConfig: CreateSessionConfig = {
    model: input.model ?? config.model,
    workingDirectory: input.workingDirectory ?? process.cwd(),
    systemMessage: { mode: 'append' as const, content: input.systemPrompt },
    skillDirectories: input.skillDirectories ?? [config.skillsDir],
    ...(input.mcpServers && Object.keys(input.mcpServers).length ? { mcpServers: input.mcpServers } : {}),
    customAgents: [
      {
        name: 'lead-data-agent',
        description: 'Lead Data Agent for evidence-backed data modernization investigation and architecture analysis.',
        prompt: 'Act as the lead data agent. Follow the loaded Skills for investigation and domain-specific methodology. Do not invent enterprise facts.',
        skills: input.skills ?? config.copilotSkills,
      },
    ],
    agent: 'lead-data-agent',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

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
  const off = session.on('assistant.message_delta', (e) => {
    if (e.data.deltaContent) {
      content += e.data.deltaContent;
      input.onDelta?.(e.data.deltaContent);
    }
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
    off();
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
