import * as z from 'zod';
import { ControlAgentSchema, ControlResearchSchema } from '../investigation/schemas.js';

export const CreateSessionBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  userPrompt: z.string().trim().optional(),
}).strict();

export const UpdateConfigBodySchema = z.object({
  research: ControlResearchSchema,
  agent: ControlAgentSchema,
}).strict();

export const MessageBodySchema = z.object({
  message: z.string().trim().min(1),
  turnId: z.string().trim().min(1).optional(),
}).strict();

export const AbortBodySchema = z.object({
  turnId: z.string().trim().min(1),
}).strict();

export class RequestValidationError extends Error {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super('请求参数不正确，请检查后重试。');
    this.name = 'RequestValidationError';
  }
}

export function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(result.error.issues);
  return result.data;
}
