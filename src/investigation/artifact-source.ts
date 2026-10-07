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
 * Capture the exact Investigation + Discovery source used by artifact generation.
 * The pair is treated as the immutable input snapshot for the whole operation.
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

export function assertInvestigationArtifactSourceScope(source: InvestigationArtifactSource): void {
  const result = evaluateInvestigationScopeGate(
    source.investigation,
    new Set(source.investigation.evidence.map((item) => item.id)),
  );
  if (!result.passed) throw new ScopeGateError(result);
}