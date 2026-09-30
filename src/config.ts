import 'dotenv/config';
import path from 'node:path';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const workspaceDir = path.resolve(env('WORKSPACE_DIR', '.workspace'));
const legacyDataDir = path.resolve(env('DATA_DIR', '.data'));

export const config = {
  workspaceDir,
  sharedDir: path.join(workspaceDir, 'shared'),
  legacyDataDir,
  githubToken: env('GITHUB_TOKEN', '') || undefined,
  model: env('COPILOT_MODEL', 'gpt-5-mini'),
  turnTimeoutMs: Number(env('TURN_TIMEOUT_MS', '300000')) || 300_000,
  port: Number(env('PORT', '3000')) || 3000,
  host: env('HOST', '127.0.0.1'),
  nodeEnv: env('NODE_ENV', 'development'),
} as const;
