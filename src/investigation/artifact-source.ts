import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir, type Investigation } from './store.js';
import { assertDiscoverySnapshotCompatible } from './artifact-provenance.js';
import { evaluateInvestigationScopeGate, ScopeGateError } from '../workflow/scope-gate.js';
import type { DiscoverySnapshot } from '../workflow/discover.js';

export interface InvestigationArtifactSource {
  readonly investigation: Investigation;
  readonly snapshot: DiscoverySnapshot | null;
  readonly analysisArtifacts: readonly string[];
}

/**
 * 捕获生成正式结果时真正使用的 Investigation + Discovery 输入快照。
 * 这里返回的对象是当前一次生成操作的只读输入；后续 Reviewer、报告生成和 provenance 都必须
 * 基于这同一份快照，不能一半读取旧状态、一半读取新状态。
 */
export async function captureInvestigationArtifactSource(name: string): Promise<InvestigationArtifactSource> {
  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  assertDiscoverySnapshotCompatible(investigation, snapshot);

  const analysisRoot = path.join(reportsDir(name), '..', 'artifacts', 'analysis');
  let analysisArtifacts: string[] = [];
  try {
    analysisArtifacts = (await fs.readdir(analysisRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error;
    }
  }

  return Object.freeze({ investigation, snapshot, analysisArtifacts });
}

/**
 * 对正式结果的 source snapshot 再做一次 Scope Gate。
 * artifact generation 不能仅依赖调用入口之前做过的校验，因为 capture 与后续生成之间仍可能发生状态变化。
 */
export function assertInvestigationArtifactSourceScope(source: InvestigationArtifactSource): void {
  const result = evaluateInvestigationScopeGate(
    source.investigation,
    new Set(source.investigation.evidence.map((item) => item.id)),
  );
  if (!result.passed) throw new ScopeGateError(result);
}