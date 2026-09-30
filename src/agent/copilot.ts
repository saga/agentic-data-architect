import { CopilotClient } from '@github/copilot-sdk';
import { config } from '../config.js';

/**
 * Copilot SDK 最小封装：优先复用本机 `copilot` CLI 登录状态。
 *
 * 参考 team-member-copilot-agent/server/copilot.ts 的两条纪律（这里只保留结论）：
 *  1. resume 失败 ≠ session 不存在，只有明确 not-found 才降级 create。
 *  2. sendAndWait 超时 ≠ 取消，超时后必须 abort，否则引擎还在后台跑。
 *
 * V1 刻意不做：tool 授权、capability 适配、multi-turn 锁、MCP。
 * 上下文以纯文本形式拼进 prompt（只读），不给模型任何写工具。
 */

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
  /** 不传 = 每次新建 session（V1 默认无状态）；传 = 复用长期 session */
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
        /* abort 失败也只能抛原始超时 */
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
    // 存在性不明时再问一次权威来源，查不到才认为是新建
    try {
      if ((await c.getSessionMetadata(sessionId)) === undefined) {
        return c.createSession(sessionConfig);
      }
    } catch {
      /* 连元数据都查不了：保留原始错误，不伪装成新会话 */
    }
    throw e;
  }
}
