import { loadInvestigation, loadLatestSnapshot, type Investigation } from './store.js';
import { assertDiscoverySnapshotCompatible } from './artifact-provenance.js';
import { evaluateInvestigationScopeGate, ScopeGateError } from '../workflow/scope-gate.js';
import type { DiscoverySnapshot } from '../workflow/discover.js';

export interface InvestigationArtifactSource {
  readonly investigation: Investigation;
  readonly snapshot: DiscoverySnapshot | null;
}

/**
 * Capture the exact Investigation + Discovery source used by artifact generation.
 * The pair is treated as the immutable input snapshot for the whole operation.
 */
export async function captureInvestigationArtifactSource(name: string): Promise<InvestigationArtifactSource> {
  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  assertDiscoverySnapshotCompatible(investigation, snapshot);
  return Object.freeze({ investigation, snapshot });
}

export function assertInvestigationArtifactSourceScope(source: InvestigationArtifactSource): void {
  const result = evaluateInvestigationScopeGate(
    source.investigation,
    new Set(source.investigation.evidence.map((item) => item.id)),
  );
  if (!result.passed) throw new ScopeGateError(result);
}