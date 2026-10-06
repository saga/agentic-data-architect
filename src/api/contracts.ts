import * as z from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
  details: z.unknown().optional(),
}).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SseCheckpointSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  confirmed: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  unknowns: z.array(z.string()),
  nextStep: z.string().optional(),
  turnId: z.string().optional(),
  execution: z.number().int().nonnegative().optional(),
}).strict();

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), data: z.object({ turnId: z.string().min(1) }).strict() }),
  z.object({ event: z.literal('heartbeat'), data: z.object({ timestamp: z.string().datetime() }).strict() }),
  z.object({ event: z.literal('status'), data: z.object({ status: z.string() }).strict() }),
  z.object({ event: z.literal('delta'), data: z.object({ delta: z.string() }).strict() }),
  z.object({ event: z.literal('reasoning'), data: z.object({ delta: z.string() }).strict() }),
  z.object({ event: z.literal('companion_note'), data: z.object({ note: z.string() }).strict() }),
  z.object({ event: z.literal('checkpoint'), data: SseCheckpointSchema }),
  z.object({ event: z.literal('completed'), data: z.record(z.string(), z.unknown()) }),
  z.object({ event: z.literal('error'), data: z.object({ code: z.string().optional(), error: z.string().min(1) }).strict() }),
]).strict();
export type SseEvent = z.infer<typeof SseEventSchema>;
