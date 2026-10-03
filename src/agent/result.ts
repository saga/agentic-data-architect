/**
 * Agent 结构化输出解析和 Evidence 校验。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键边界，方便后续维护。
 */
import * as z from 'zod';
import { calibrateStatus, ClaimStatusSchema, type Claim, type ClaimStatus, type EvidenceRef } from '../evidence/types.js';
import { JourneyRouteOptionSchema } from '../investigation/schemas.js';

/**
 * 结构化 Agent 结果：
 * 自然语言 → JSON 抽取 → Zod schema 校验 → evidenceId 所属校验 → 状态校正 → 保存。
 */
export const AgentClaimDraftSchema = z.object({
  claim: z.string().trim().min(1).max(2000).catch(''),
  status: ClaimStatusSchema.catch('inferred'),
  evidenceIds: z.array(z.string()).catch([]),
});

/** Zod Schema 推导出的 Claim 草稿类型。 */
export type AgentClaimDraft = z.infer<typeof AgentClaimDraftSchema>;

/** Agent 最终结构化答案的运行时 Schema；允许单个坏 Claim 通过 catch 降级而不丢掉整份答案。 */
export const AgentAnswerSchema = z.object({
  answer: z.string().max(8000).catch(''),
  claims: z.array(AgentClaimDraftSchema.nullable().catch(null))
    .catch([])
    .transform((items) => items.filter((item): item is AgentClaimDraft => item !== null && item.claim.length > 0)),
  unknowns: z.array(z.string().max(500)).catch([]),
  followUpQuestions: z.array(z.string().max(500)).catch([]),
  routeOptions: z.array(JourneyRouteOptionSchema.nullable().catch(null))
    .catch([])
    .transform((items) => items.filter((item) => item !== null).slice(0, 3)),
  workflow: z.object({
    nodeId: z.string(),
    outcome: z.string(),
  }).strict().optional().transform((value) => {
    if (!value?.nodeId.trim() || !value.outcome.trim()) return undefined;
    return {
      nodeId: value.nodeId.trim(),
      outcome: value.outcome.trim(),
    };
  }),
});

/** Zod Schema 推导出的结构化 Agent 答案类型。 */
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

/** 经过 Schema 校验、Evidence ownership 校验和状态校正后的最终解析结果。 */
export interface ParsedAnswer extends AgentAnswer {
  warnings: string[];
  droppedEvidenceRefs: string[];
}

/** 当完整 AgentAnswer Schema 失败时，仍尽量取出模型已经生成的自然语言 answer，
 * 避免把内部结构化 JSON 直接展示给用户。 */
function extractAnswerFromRaw(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(extractJson(raw)) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && 'answer' in parsed
      && typeof parsed.answer === 'string'
      && parsed.answer.trim()
    ) {
      return parsed.answer.trim();
    }
  } catch {
    // 不是完整 JSON 时继续走原始文本 fallback。
  }
  return undefined;
}

/** 从模型回复中提取可能的 JSON；兼容 markdown fence 和前后夹杂解释文本。 */
function extractJson(raw: string): string {
  const fenced = raw.match(new RegExp('\\x60{3}(?:json)?\\s*([\\s\\S]*?)\\x60{3}'));
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

/** 解析并校验模型答案，再删除不存在的 Evidence 引用并重新校正 Claim 状态。 */
export function parseAgentAnswer(raw: string, existingEvidence: Set<string> | Map<string, EvidenceRef>): ParsedAnswer {
  const warnings: string[] = [];
  const droppedEvidenceRefs: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw)) as unknown;
  } catch {
    return {
      answer: extractAnswerFromRaw(raw) ?? raw.slice(0, 2000),
      claims: [],
      unknowns: ['模型没有返回合法 JSON，需要重问或收紧提示词'],
      followUpQuestions: [],
      routeOptions: [],
      workflow: undefined,
      warnings: ['这次回答没有返回可解析的结构化结果，系统只保存了原始回答，没有保存 Claims。'],
      droppedEvidenceRefs,
    };
  }

  const parsed = AgentAnswerSchema.safeParse(data);
  if (!parsed.success) {
    return {
      answer: extractAnswerFromRaw(raw) ?? raw.slice(0, 2000),
      claims: [],
      unknowns: ['模型返回的结构化结果不符合预期，需要重问或收紧提示词'],
      followUpQuestions: [],
      routeOptions: [],
      workflow: undefined,
      warnings: ['这次回答不符合结构化结果 Schema，系统只保存了原始回答，没有保存 Claims。'],
      droppedEvidenceRefs,
    };
  }

  const claims: AgentClaimDraft[] = [];
  for (const draft of parsed.data.claims) {
    const kept = draft.evidenceIds.filter((id) => {
      if ((existingEvidence instanceof Set ? existingEvidence.has(id) : existingEvidence.has(id))) return true;
      droppedEvidenceRefs.push(id);
      return false;
    });
    if (kept.length < draft.evidenceIds.length) {
      warnings.push(`回答引用了不存在的 Evidence，系统已删除 ${draft.evidenceIds.length - kept.length} 个无效引用。`);
    }
    const keptEvidence = kept.map((id) => existingEvidence instanceof Set ? undefined : existingEvidence.get(id)).filter((item): item is EvidenceRef => Boolean(item));
    const status: ClaimStatus = calibrateStatus(existingEvidence instanceof Set ? kept.length : keptEvidence, draft.status);
    claims.push({ claim: draft.claim.slice(0, 2000), status, evidenceIds: kept });
  }

  return {
    answer: parsed.data.answer,
    claims,
    unknowns: parsed.data.unknowns,
    followUpQuestions: parsed.data.followUpQuestions,
    routeOptions: parsed.data.routeOptions,
    workflow: parsed.data.workflow,
    warnings,
    droppedEvidenceRefs,
  };
}

/** 把模型层 ParsedAnswer 转成可持久化的业务 Claim，并由调用方生成唯一 ID。 */
export function toClaims(parsed: ParsedAnswer, mkId: () => string): Claim[] {
  return parsed.claims.map((c) => ({ id: mkId(), claim: c.claim, status: c.status, evidenceIds: c.evidenceIds }));
}
