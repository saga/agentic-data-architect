import 'dotenv/config';
import path from 'node:path';
import * as z from 'zod';

const EnvSchema = z.object({
  WORKSPACE_DIR: z.string().default('.workspace'),
  DATA_DIR: z.string().default('.data'),
  SKILLS_DIR: z.string().default('skills'),
  COPILOT_SKILLS: z.string().default('investigation-session,financial-data-review'),
  GITHUB_TOKEN: z.string().optional(),
  COPILOT_MODEL: z.string().default('gpt-5-mini'),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z.string().min(1).default('development'),
});

const envConfig = EnvSchema.parse(process.env);
const copilotSkills = envConfig.COPILOT_SKILLS.split(',').map((skill) => skill.trim()).filter(Boolean);

export const config = {
  workspaceDir: path.resolve(envConfig.WORKSPACE_DIR),
  sharedDir: path.resolve(envConfig.WORKSPACE_DIR, 'shared'),
  legacyDataDir: path.resolve(envConfig.DATA_DIR),
  skillsDir: path.resolve(envConfig.SKILLS_DIR),
  copilotSkills,
  githubToken: envConfig.GITHUB_TOKEN?.trim() || undefined,
  model: envConfig.COPILOT_MODEL,
  turnTimeoutMs: envConfig.TURN_TIMEOUT_MS,
  port: envConfig.PORT,
  host: envConfig.HOST,
  nodeEnv: envConfig.NODE_ENV,
} as const;
