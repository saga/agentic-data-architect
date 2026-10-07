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
  COPILOT_MODEL: z.string().default('auto'),
  /** Default Agent Runtime for newly created Investigations. */
  AGENT_RUNTIME_DEFAULT: z.enum(['codebuddy-sdk', 'copilot-sdk', 'opencode-run']).default('copilot-sdk'),
  /** Ordered runtime fallback chain; a selected runtime starts at its own position. */
  AGENT_RUNTIME_FALLBACK_ORDER: z.string().default('copilot-sdk,codebuddy-sdk,opencode-run'),
  /** Ordered CodeBuddy model filter; the first model is the default unless overridden explicitly. */
  CODEBUDDY_MODEL_ALLOWLIST: z.string().default('glm-5.3-flash,deepseek-v4.1-flash,space-bunny'),
  /** Default CodeBuddy model. Must normally be present in CODEBUDDY_MODEL_ALLOWLIST. */
  CODEBUDDY_DEFAULT_MODEL: z.string().default('glm-5.3-flash'),
  /** Maximum agent/tool loop turns inside one CodeBuddy SDK query. */
  CODEBUDDY_MAX_TURNS: z.coerce.number().int().min(1).max(1000).default(200),
  /** 是否允许工作台发现并使用本机 OpenCode Server。默认开启发现，不代表自动切换。 */
  OPENCODE_ENABLED: z.enum(['true', 'false']).default('true'),
  /** OpenCode Server 地址；默认使用 opencode serve 的本机地址。 */
  OPENCODE_BASE_URL: z.string().url().default('http://127.0.0.1:4096'),
  /** OpenCode Server 开启 Basic Auth 时，沿用 OpenCode 官方环境变量。通常本机开发无需填写。 */
  OPENCODE_SERVER_USERNAME: z.string().optional(),
  OPENCODE_SERVER_PASSWORD: z.string().optional(),
  /**
   * OpenCode 模型白名单（逗号分隔，大小写不敏感子串匹配）。
   * 每项匹配模型 id（如 opencode:opencode/muse-spark-1.3-contributor-free）或显示名。
   * 为空 = 不过滤，全部列出；填了就只列出命中的，下拉框不再是一大堆。
   */
  OPENCODE_MODEL_ALLOWLIST: z.string().default(''),
  /** Copilot quota 用尽时的自动 fallback 模型；为空时使用 OpenCode 当前首个已连接模型。 */
  OPENCODE_FALLBACK_MODEL: z.string().default(''),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(360_000),
  // Agent 真正执行的默认上限仍为 6 分钟；进入 ask_user 后改用单独的等待上限。
  USER_INPUT_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  // 权限确认和 Agent 实际计算是两种等待。用户没有及时点“允许/拒绝”时，不能被 6 分钟执行超时误杀。
  PERMISSION_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  GRAPHIFY_ENABLED: z.enum(['true', 'false']).default('true'),
  GRAPHIFY_MCP_COMMAND: z.string().min(1).default('graphify-mcp'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  ALLOW_REMOTE_HOST: z.enum(['true', 'false']).default('false'),
  NODE_ENV: z.string().min(1).default('development'),
});

// 这里是整个服务的唯一运行时配置输入源，后续模块不直接读取 process.env。
const envConfig = EnvSchema.parse(process.env);
/** 全局不可变运行配置。业务代码只消费这里的解析结果，不自行解析环境变量。 */
export const config = {
  workspaceDir: path.resolve(envConfig.WORKSPACE_DIR),
  sharedDir: path.resolve(envConfig.WORKSPACE_DIR, 'shared'),
  dataDir: path.resolve(envConfig.DATA_DIR),
  skillsDir: path.resolve(envConfig.SKILLS_DIR),
  knowledgeDir: path.resolve(envConfig.KNOWLEDGE_DIR),
  githubToken: envConfig.GITHUB_TOKEN?.trim() || undefined,
  model: envConfig.COPILOT_MODEL,
  agentRuntimeDefault: envConfig.AGENT_RUNTIME_DEFAULT,
  agentRuntimeFallbackOrder: envConfig.AGENT_RUNTIME_FALLBACK_ORDER.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  codeBuddyModelAllowlist: envConfig.CODEBUDDY_MODEL_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  codeBuddyDefaultModel: envConfig.CODEBUDDY_DEFAULT_MODEL.trim(),
  codeBuddyMaxTurns: envConfig.CODEBUDDY_MAX_TURNS,
  openCodeEnabled: envConfig.OPENCODE_ENABLED === 'true',
  openCodeBaseUrl: envConfig.OPENCODE_BASE_URL.replace(/\/+$/, ''),
  openCodeUsername: envConfig.OPENCODE_SERVER_USERNAME?.trim() || undefined,
  openCodePassword: envConfig.OPENCODE_SERVER_PASSWORD || undefined,
  openCodeModelAllowlist: envConfig.OPENCODE_MODEL_ALLOWLIST.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
  openCodeFallbackModel: envConfig.OPENCODE_FALLBACK_MODEL.trim() || undefined,
  turnTimeoutMs: envConfig.TURN_TIMEOUT_MS,
  userInputWaitTimeoutMs: envConfig.USER_INPUT_WAIT_TIMEOUT_MS,
  permissionWaitTimeoutMs: envConfig.PERMISSION_WAIT_TIMEOUT_MS,
  graphifyEnabled: envConfig.GRAPHIFY_ENABLED === 'true',
  graphifyMcpCommand: envConfig.GRAPHIFY_MCP_COMMAND,
  graphifyPlatformCapabilityVersion: 1,
  port: envConfig.PORT,
  host: envConfig.HOST,
  allowRemoteHost: envConfig.ALLOW_REMOTE_HOST === 'true',
  nodeEnv: envConfig.NODE_ENV,
} as const;
