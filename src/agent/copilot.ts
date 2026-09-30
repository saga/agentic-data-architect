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

export interface AskInput {
  prompt: string;
  systemPrompt: string;
  /** When provided, the same resumable Copilot session is reused across turns/processes. */
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
}

export async function askCopilot(input: AskInput): Promise<string> {
  const c = await getClient();
  const sessionConfig = {
    model: input.model ?? config.model,
    workingDirectory: input.workingDirectory ?? process.cwd(),
    systemMessage: { mode: 'append' as const, content: input.systemPrompt },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  const session = input.sessionId
    ? await resumeOrCreate(c, input.sessionId, sessionConfig)
    : await c.createSession(sessionConfig);

  let content = '';
  const off = session.on('assistant.message_delta', (e) => {
    if (e.data.deltaContent) content += e.data.deltaContent;
  });
  try {
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
