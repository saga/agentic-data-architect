/**
 * HTTP API Runtime Schema。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import * as z from 'zod';
import { ControlAgentSchema, ControlResearchSchema, WorkflowIdSchema } from '../investigation/schemas.js';

const WorkflowSelectionSchema = WorkflowIdSchema.nullable().or(z.literal('')).transform((value) => value === '' ? null : value);

/** 创建 Investigation Session 的 HTTP 请求体 Schema。 */
export const CreateSessionBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  userPrompt: z.string().trim().optional(),
  workflow: WorkflowSelectionSchema.optional(),
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

/** 发送 Agent 问题的 HTTP 请求体 Schema，保证 message 非空。 */
export const MessageBodySchema = z.object({
  message: z.string().trim().min(1),
  turnId: z.string().trim().min(1).optional(),
}).strict();

/** Stop 请求的 HTTP 请求体 Schema，要求提供 turnId。 */
export const AbortBodySchema = z.object({
  turnId: z.string().trim().min(1),
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
  mode: z.enum(['generate', 'modify']),
  prompt: z.string().trim().min(1).max(4000),
  messages: z.array(JourneyAiMessageSchema).max(12).optional(),
}).strict();
