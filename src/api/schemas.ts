/**
 * HTTP API Runtime Schema。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import * as z from 'zod';
import { AgentRuntimeSchema, ControlAgentSchema, ControlResearchSchema, WorkflowIdSchema } from '../investigation/schemas.js';

const WorkflowSelectionSchema = WorkflowIdSchema.nullable().or(z.literal('')).transform((value) => value === '' ? null : value);

/** 创建 Investigation Session 的 HTTP 请求体 Schema。 */
export const CreateSessionBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  userPrompt: z.string().trim().optional(),
  workflow: WorkflowSelectionSchema.optional(),
  runtime: AgentRuntimeSchema.optional(),
}).strict();

/** 确认 Investigation Mission；确认后服务端才允许开始正式调查。 */
export const UpdateMissionBodySchema = z.object({
  purpose: z.string().trim().min(10).max(2000),
  expectedResult: z.string().trim().min(10).max(4000),
}).strict();

/** 修改 Investigation 当前采用的可选工作路线。null 表示回到自主调查。 */
export const UpdateWorkflowBodySchema = z.object({
  workflow: WorkflowSelectionSchema,
}).strict();

/** 保存 Investigation research / Agent 配置的 HTTP 请求体 Schema。 */
export const UpdateConfigBodySchema = z.object({
  research: ControlResearchSchema,
  agent: ControlAgentSchema,
}).strict();

/** 保存工作台级 Global Agent 默认配置；不会修改任何 Investigation 的 Task Override。 */
export const UpdateGlobalConfigBodySchema = z.object({
  agent: ControlAgentSchema,
}).strict();

/** 主对话框修改模型和 Auto 选择方式时使用的轻量请求 Schema。 */
export const UpdateAgentModelBodySchema = z.object({
  model: z.string().trim().min(1).max(200),
  /** null 表示恢复 Copilot 的默认 Auto 选择；只有 model=auto 时才会生效。 */
  autoTier: z.enum(['efficiency', 'balance', 'intelligence', 'fast']).nullable().optional(),
}).strict();

/** 发送 Agent 问题或选择一个下一步动作；两者都走同一条执行通道。 */
export const MessageBodySchema = z.object({
  message: z.string().trim().min(1).optional(),
  routeId: z.string().trim().min(1).max(80).optional(),
  /** true 表示这是用户点击 Agent 提供的“继续调查”引导，不是重新提出同一个普通问题。 */
  guided: z.boolean().default(false),
  turnId: z.string().trim().min(1).optional(),
}).strict().refine(
  (value) => Boolean(value.message || value.routeId),
  { message: '请输入问题，或选择一个下一步动作。' },
);

/** Stop 请求的 HTTP 请求体 Schema，要求提供 turnId。 */
export const AbortBodySchema = z.object({
  turnId: z.string().trim().min(1),
}).strict();

/** 前端处理 Agent 权限请求；scope=session 表示批准当前 Copilot Session 后续继续使用这项权限。 */
export const PermissionResponseBodySchema = z.object({
  turnId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  allowed: z.boolean(),
  /** once = 只允许这一次；session = 使用 Copilot SDK 的会话级批准。 */
  scope: z.enum(['once', 'session']).default('once'),
}).strict().superRefine((value, ctx) => {
  if (!value.allowed && value.scope === 'session') {
    ctx.addIssue({
      code: 'custom',
      path: ['scope'],
      message: '拒绝操作时不能使用会话级批准。',
    });
  }
});

/** 回答 Agent 的 ask_user 请求；requestId 是工作台生成的运行态请求 ID。 */
export const UserInputResponseBodySchema = z.object({
  turnId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  answer: z.string().trim().min(1).max(8000),
  wasFreeform: z.boolean(),
}).strict();

/** API 输入 Schema 验证失败时使用的统一错误类型，交给 Express 错误处理中间件转换成 400。 */
export class RequestValidationError extends Error {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super('请求参数不正确，请检查后重试。');
    this.name = 'RequestValidationError';
  }
}

/** 对 HTTP body 执行 Zod runtime validation，成功返回已解析数据，失败抛出统一业务错误。 */
export function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(result.error.issues);
  return result.data;
}


/** 工作地图 AI 对话中的一条历史消息。只保存用户消息和 AI 的简短回复，不保存思维链。 */
export const JourneyAiMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(8000),
}).strict();

/** 工作地图 AI 请求。AI 只处理工作流图，不参与数据分析。 */
export const JourneyAiRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  messages: z.array(JourneyAiMessageSchema).max(12).optional(),
  /** 当前画布的未保存 Definition；服务端仍会重新用 Workflow schema 校验。 */
  definition: z.unknown().optional(),
  /** 当前选中的步骤只作为上下文，不限制 AI 可以修改的范围。 */
  selectedNodeId: z.string().trim().min(1).optional(),
}).strict();


/** 人工完成 waiting Workflow 节点时提交的 outcome。 */
export const JourneyTransitionBodySchema = z.object({
  nodeId: z.string().trim().min(1),
  outcome: z.string().trim().min(1),
}).strict();
