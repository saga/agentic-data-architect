/**
 * 应用运行时配置。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import 'dotenv/config';
import path from 'node:path';
import * as z from 'zod';

/** 运行时环境变量 Schema；把字符串环境变量在服务启动时一次性转换成可靠类型。 */
const EnvSchema = z.object({
  WORKSPACE_DIR: z.string().default('.workspace'),
  DATA_DIR: z.string().default('.data'),
  SKILLS_DIR: z.string().default('skills'),
  KNOWLEDGE_DIR: z.string().default('knowledge'),
  GITHUB_TOKEN: z.string().optional(),
  COPILOT_MODEL: z.string().default('gpt-5-mini'),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(360_000),
  GRAPHIFY_ENABLED: z.enum(['true', 'false']).default('true'),
  GRAPHIFY_MCP_COMMAND: z.string().min(1).default('graphify-mcp'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z.string().min(1).default('development'),
});

// 这里是整个服务的唯一运行时配置输入源，后续模块不直接读取 process.env。
const envConfig = EnvSchema.parse(process.env);
/** 全局不可变运行配置。业务代码只消费这里的解析结果，不自行解析环境变量。 */
export const config = {
  workspaceDir: path.resolve(envConfig.WORKSPACE_DIR),
  sharedDir: path.resolve(envConfig.WORKSPACE_DIR, 'shared'),
  legacyDataDir: path.resolve(envConfig.DATA_DIR),
  skillsDir: path.resolve(envConfig.SKILLS_DIR),
  knowledgeDir: path.resolve(envConfig.KNOWLEDGE_DIR),
  githubToken: envConfig.GITHUB_TOKEN?.trim() || undefined,
  model: envConfig.COPILOT_MODEL,
  turnTimeoutMs: envConfig.TURN_TIMEOUT_MS,
  graphifyEnabled: envConfig.GRAPHIFY_ENABLED === 'true',
  graphifyMcpCommand: envConfig.GRAPHIFY_MCP_COMMAND,
  graphifyPlatformCapabilityVersion: 1,
  port: envConfig.PORT,
  host: envConfig.HOST,
  nodeEnv: envConfig.NODE_ENV,
} as const;
