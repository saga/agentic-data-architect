import * as z from 'zod';
import { WorkflowIdSchema } from '../investigation/schemas.js';

/** 外部知识来源类型；用于解释“为什么这个来源值得信”。 */
export const KnowledgeSourceTypeSchema = z.enum([
  'regulator',
  'official_standard',
  'official_architecture',
  'employer_role',
  'practitioner_case',
  'practitioner_article',
  'secondary_summary',
]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>;

export const KnowledgeConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type KnowledgeConfidence = z.infer<typeof KnowledgeConfidenceSchema>;

export const KnowledgeTimeSensitivitySchema = z.enum(['stable', 'contextual', 'time-sensitive']);
export type KnowledgeTimeSensitivity = z.infer<typeof KnowledgeTimeSensitivitySchema>;

export const KnowledgeSourceSchema = z.object({
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.string().url(),
  sourceType: KnowledgeSourceTypeSchema,
  publishedAt: z.string().optional(),
  sourceConfidence: KnowledgeConfidenceSchema,
  note: z.string().optional(),
}).strict();
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

export const ArchitectureKnowledgeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['practice', 'principle', 'assessment-pattern', 'financial-control']),
  status: z.literal('active'),
  summary: z.string().min(1),
  appliesTo: z.array(WorkflowIdSchema).min(1),
  tags: z.array(z.string()),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  checks: z.array(z.string()),
  cautions: z.array(z.string()),
  knowledgeConfidence: KnowledgeConfidenceSchema,
  confidenceBasis: z.string().min(1),
  timeSensitivity: KnowledgeTimeSensitivitySchema,
  reviewedAt: z.string().min(1),
  sources: z.array(KnowledgeSourceSchema).min(1),
}).strict();
export type ArchitectureKnowledge = z.infer<typeof ArchitectureKnowledgeSchema>;

export const ArchitectureKnowledgeBankSchema = z.array(ArchitectureKnowledgeSchema);