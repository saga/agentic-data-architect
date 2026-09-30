import { calibrateStatus, type Claim, type ClaimStatus } from '../evidence/types.js';

/**
 * 结构化 Agent 结果（§十六、§十七）：
 * 自然语言 → JSON 抽取 → schema 校验 → evidenceId 存在性校验 → 状态校正 → 保存。
 * 模型自报的 status 只做输入，系统按证据数量重算（verified 永不直接采信）。
 */

export interface AgentClaimDraft {
  claim: string;
  status: ClaimStatus;
  evidenceIds: string[];
}

export interface AgentAnswer {
  answer: string;
  claims: AgentClaimDraft[];
  unknowns: string[];
  followUpQuestions: string[];
}

export interface ParsedAnswer extends AgentAnswer {
  warnings: string[];
  droppedEvidenceRefs: string[];
}

const VALID_STATUS: ClaimStatus[] = ['verified', 'supported', 'inferred', 'unknown', 'contradicted'];

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

/** 解析并校验模型输出；existingIds 是本 investigation 真实存在的 evidence id。 */
export function parseAgentAnswer(raw: string, existingIds: Set<string>): ParsedAnswer {
  const warnings: string[] = [];
  const droppedEvidenceRefs: string[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  } catch {
    return {
      answer: raw.slice(0, 2000),
      claims: [],
      unknowns: ['模型没有返回合法 JSON，需要重问或收紧提示词'],
      followUpQuestions: [],
      warnings: ['unparseable agent output: saved as raw text only, no claims'],
      droppedEvidenceRefs,
    };
  }
  const claims: AgentClaimDraft[] = [];
  const rawClaims = Array.isArray(data['claims']) ? (data['claims'] as unknown[]) : [];
  for (const rc of rawClaims) {
    if (typeof rc !== 'object' || rc === null) continue;
    const r = rc as Record<string, unknown>;
    if (typeof r['claim'] !== 'string' || !r['claim'].trim()) continue;
    const status = VALID_STATUS.includes(r['status'] as ClaimStatus) ? (r['status'] as ClaimStatus) : 'inferred';
    const ids = Array.isArray(r['evidenceIds']) ? r['evidenceIds'].filter((x): x is string => typeof x === 'string') : [];
    const kept = ids.filter((id) => {
      if (existingIds.has(id)) return true;
      droppedEvidenceRefs.push(id);
      return false;
    });
    if (kept.length < ids.length) warnings.push(`claim 引用了不存在的 evidence，已剔除 ${ids.length - kept.length} 个`);
    claims.push({ claim: (r['claim'] as string).slice(0, 2000), status: calibrateStatus(kept.length, status), evidenceIds: kept });
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 500)) : [];
  return {
    answer: typeof data['answer'] === 'string' ? (data['answer'] as string).slice(0, 8000) : '',
    claims,
    unknowns: strings(data['unknowns']),
    followUpQuestions: strings(data['followUpQuestions']),
    warnings,
    droppedEvidenceRefs,
  };
}

/** ParsedAnswer → 可存盘的 Claim（id 由调用方生成后传入或这里生成）。 */
export function toClaims(parsed: ParsedAnswer, mkId: () => string): Claim[] {
  return parsed.claims.map((c) => ({ id: mkId(), claim: c.claim, status: c.status, evidenceIds: c.evidenceIds }));
}
