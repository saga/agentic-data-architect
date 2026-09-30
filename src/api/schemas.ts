/**
 * HTTP API Runtime Schema。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import * as z from 'zod';
import { ControlAgentSchema, ControlResearchSchema } from '../investigation/schemas.js';

/** 创建 Investigation Session 的 HTTP 请求体 Schema。 */
export const CreateSessionBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  userPrompt: z.string().trim().optional(),
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
