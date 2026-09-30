import * as z from 'zod';
import { calibrateStatus, ClaimStatusSchema, type Claim, type ClaimStatus } from '../evidence/types.js';

/**
 * 结构化 Agent 结果：
 * 自然语言 → JSON 抽取 → Zod schema 校验 → evidenceId 所属校验 → 状态校正 → 保存。
 */
export const AgentClaimDraftSchema = z.object({
  claim: z.string().trim().min(1).max(2000).catch(''),
  status: ClaimStatusSchema.catch('inferred'),
  evidenceIds: z.array(z.string()).catch([]),
}).strict();

export type AgentClaimDraft = z.infer<typeof AgentClaimDraftSchema>;

export const AgentAnswerSchema = z.object({
  answer: z.string().max(8000).catch(''),
  claims: z.array(AgentClaimDraftSchema.catch(null))
    .catch([])
    .transform((items) => items.filter((item): item is AgentClaimDraft => item !== null && item.claim.length > 0)),
  unknowns: z.array(z.string().max(500)).catch([]),
  followUpQuestions: z.array(z.string().max(500)).catch([]),
}).strict();

export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

export interface ParsedAnswer extends AgentAnswer {
  warnings: string[];
  droppedEvidenceRefs: string[];
}

function extractJson(raw: string): string {
  const fenced = raw.match(new RegExp('\\x60{3}(?:json)?\\s*([\\s\\S]*?)\\x60{3}'));
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

export function parseAgentAnswer(raw: string, existingIds: Set<string>): ParsedAnswer {
  const warnings: string[] = [];
  const droppedEvidenceRefs: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw)) as unknown;
  } catch {
    return {
      answer: raw.slice(0, 2000),
      claims: [],
      unknowns: ['模型没有返回合法 JSON，需要重问或收紧提示词'],
      followUpQuestions: [],
      warnings: ['这次回答没有返回可解析的结构化结果，系统只保存了原始回答，没有保存 Claims。'],
      droppedEvidenceRefs,
    };
  }

  const parsed = AgentAnswerSchema.safeParse(data);
  if (!parsed.success) {
    return {
      answer: raw.slice(0, 2000),
      claims: [],
      unknowns: ['模型返回的结构化结果不符合预期，需要重问或收紧提示词'],
      followUpQuestions: [],
      warnings: ['这次回答不符合结构化结果 Schema，系统只保存了原始回答，没有保存 Claims。'],
      droppedEvidenceRefs,
    };
  }

  const claims: AgentClaimDraft[] = [];
  for (const draft of parsed.data.claims) {
    const kept = draft.evidenceIds.filter((id) => {
      if (existingIds.has(id)) return true;
      droppedEvidenceRefs.push(id);
      return false;
    });
    if (kept.length < draft.evidenceIds.length) {
      warnings.push(`回答引用了不存在的 Evidence，系统已删除 ${draft.evidenceIds.length - kept.length} 个无效引用。`);
    }
    const status: ClaimStatus = calibrateStatus(kept.length, draft.status);
    claims.push({ claim: draft.claim.slice(0, 2000), status, evidenceIds: kept });
  }

  return {
    answer: parsed.data.answer,
    claims,
    unknowns: parsed.data.unknowns,
    followUpQuestions: parsed.data.followUpQuestions,
    warnings,
    droppedEvidenceRefs,
  };
}

export function toClaims(parsed: ParsedAnswer, mkId: () => string): Claim[] {
  return parsed.claims.map((c) => ({ id: mkId(), claim: c.claim, status: c.status, evidenceIds: c.evidenceIds }));
}
