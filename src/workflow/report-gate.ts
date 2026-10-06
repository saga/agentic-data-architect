/**
 * Current-State Report 的确定性 Gate。
 *
 * 目标不是要求调查“看起来很完整”，而是阻止 Agent 在没有真实调查结果、
 * 没有 Evidence 或 Claim/Finding 引用失效时，把结果包装成正式 Current-State Report。
 */
import { loadInvestigation, loadLatestSnapshot } from '../investigation/store.js';
import type { DiscoverySnapshot } from './discover.js';
import { calibrateStatus, type EvidenceRef } from '../evidence/types.js';

export interface ReportGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ReportGateResult {
  passed: boolean;
  checks: ReportGateCheck[];
}

export class ReportGateError extends Error {
  readonly result: ReportGateResult;

  constructor(result: ReportGateResult) {
    const failed = result.checks.filter((item) => !item.passed)
      .map((item) => item.name + '：' + item.detail).join('；');
    super('Current-State Report 还不能生成。' + (failed ? ' ' + failed : ''));
    this.name = 'ReportGateError';
    this.result = result;
  }
}

function allKnown(ids: string[], known: Set<string>): boolean {
  return ids.every((id) => known.has(id));
}

/** 纯函数版本，方便脚本和报告生成器共用。 */
export function evaluateCurrentStateReportGate(
  investigation: {
    discoveryRuns: Array<unknown>;
    evidence: EvidenceRef[];
    claims: Array<{ status: 'verified' | 'supported' | 'inferred' | 'unknown' | 'contradicted'; evidenceIds: string[] }>;
    findings: Array<{ evidenceIds: string[] }>;
  },
  snapshot: DiscoverySnapshot | null,
): ReportGateResult {
  const checks: ReportGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const evidenceIds = new Set(investigation.evidence.map((item) => item.id));

  add(
    '至少完成过一次 Discovery',
    investigation.discoveryRuns.length > 0,
    'discoveryRuns=' + String(investigation.discoveryRuns.length),
  );

  add(
    '最新 Discovery 快照真实存在',
    Boolean(snapshot),
    snapshot ? '已找到最新 Discovery snapshot。' : '找不到 Discovery snapshot。',
  );

  const current = snapshot?.currentState;
  add(
    'Current-State Intelligence 已生成',
    Boolean(current),
    current ? 'coverage 已生成。' : '没有 Current-State Intelligence。',
  );

  add(
    'Discovery 确实扫描到了材料',
    Boolean(current && (current.coverage.filesScanned > 0 || current.coverage.datasets > 0)),
    current
      ? 'files=' + String(current.coverage.filesScanned) + ', datasets=' + String(current.coverage.datasets)
      : '没有 coverage。',
  );

  const invalidClaims = investigation.claims.filter((claim) => {
    if (claim.status === 'unknown') return false;
    if (!allKnown(claim.evidenceIds, evidenceIds)) return true;
    const kept = investigation.evidence.filter((item) => claim.evidenceIds.includes(item.id));
    const calibrated = calibrateStatus(kept, claim.status);
    return calibrated !== claim.status;
  });
  add(
    '已确认 Claim 没有超出 Evidence 能证明的范围',
    invalidClaims.length === 0,
    invalidClaims.length
      ? '发现 ' + String(invalidClaims.length) + ' 条 Claim 的状态或 Evidence 不成立。'
      : 'Claim 状态与 Evidence 一致。',
  );

  const invalidFindings = investigation.findings.filter((finding) => !allKnown(finding.evidenceIds, evidenceIds));
  add(
    'Finding 的 Evidence 引用全部有效',
    invalidFindings.length === 0,
    invalidFindings.length
      ? '发现 ' + String(invalidFindings.length) + ' 条 Finding 引用了不存在的 Evidence。'
      : '所有 Finding 引用均有效。',
  );

  return { passed: checks.every((item) => item.passed), checks };
}

/** 从当前 Investigation 读取真实状态并执行 Current-State Report Gate。 */
export async function runCurrentStateReportGate(
  name: string,
  source?: {
    investigation: Parameters<typeof evaluateCurrentStateReportGate>[0];
    snapshot: DiscoverySnapshot | null;
  },
): Promise<ReportGateResult> {
  if (source) return evaluateCurrentStateReportGate(source.investigation, source.snapshot);
  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  return evaluateCurrentStateReportGate(investigation, snapshot);
}

/** Gate 不通过时抛出明确错误，避免生成一份“看起来完成、实际上没有调查”的报告。 */
export async function assertCurrentStateReportGate(
  name: string,
  source?: {
    investigation: Parameters<typeof evaluateCurrentStateReportGate>[0];
    snapshot: DiscoverySnapshot | null;
  },
): Promise<ReportGateResult> {
  const result = await runCurrentStateReportGate(name, source);
  if (!result.passed) throw new ReportGateError(result);
  return result;
}
