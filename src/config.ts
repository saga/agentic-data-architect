import 'dotenv/config';
import path from 'node:path';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const dataDir = path.resolve(env('DATA_DIR', '.data'));

export const config = {
  dataDir,
  investigationDir: path.join(dataDir, 'investigations'),
  /** 本机 copilot CLI 已登录即可用；CI/服务器才需要 GITHUB_TOKEN + empty 模式 */
  githubToken: env('GITHUB_TOKEN', '') || undefined,
  model: env('COPILOT_MODEL', 'gpt-5-mini'),
  /** 单轮等待上限。SDK 的 sendAndWait 超时 ≠ 取消，超时后由调用方 abort */
  turnTimeoutMs: Number(env('TURN_TIMEOUT_MS', '300000')) || 300_000,
} as const;
