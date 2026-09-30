import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateTransformations,
  findMultipleSourcesOfTruth,
  findSemanticConflicts,
  runAllFindings,
  type FindingContext,
} from '../src/analysis/findings.js';
import { nextId, type EvidenceRef } from '../src/evidence/types.js';
import type { LineageGraph } from '../src/analysis/lineage.js';

function ev(dataset: string): EvidenceRef {
  return {
    id: nextId('ev'),
    type: 'lineage',
    investigationId: 'inv',
    discoveryRunId: 'run-001',
    source: dataset,
    dataset,
    collectedAt: new Date().toISOString(),
  };
}

/** 最小 synthetic 上下文：两个 position 候选 + 各自证据。 */
function ctxWith(datasets: string[]): FindingContext {
  const evidence = datasets.map(ev);
  const byDs = new Map(evidence.map((e) => [e.dataset, e.id]));
  const lineage = {
    edges: datasets.slice(1).map((d) => ({
      source: datasets[0] as string,
      target: d,
      viaFile: 'f.sql',
      evidenceId: byDs.get(d) as string,
    })),
    tables: datasets,
    columns: [],
    statements: [],
    evidence: [],
  } satisfies LineageGraph;
  return { investigationId: 'inv', lineage, profiles: [], inventory: null as never, evidence };
}

describe('findings engine', () => {
  it('multiple position candidates -> multiple_sources_of_truth', () => {
    const ctx = ctxWith(['ibor_position', 'legacy_position', 'portfolio_position']);
    const found = findMultipleSourcesOfTruth(ctx);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.type, 'multiple_sources_of_truth');
    assert.ok((found[0]?.evidenceIds.length ?? 0) >= 2);
  });

  it('no evidence -> no finding (never invent)', () => {
    const ctx = ctxWith(['ibor_position', 'legacy_position']);
    ctx.evidence = [];
    assert.deepEqual(runAllFindings(ctx), []);
  });

  it('same expression in two targets -> duplicate_transformation', () => {
    const ctx = ctxWith(['a', 'b']);
    ctx.lineage.statements = [
      { id: 's1', file: 'f.sql', statementIndex: 0, lineStart: 1, lineEnd: 1, target: 'a', sources: [], columns: [{ targetColumn: 'mv', sourceDataset: 't', sourceColumn: 'q', expression: 'qty * price' }] },
      { id: 's2', file: 'g.sql', statementIndex: 0, lineStart: 1, lineEnd: 1, target: 'b', sources: [], columns: [{ targetColumn: 'mv', sourceDataset: 't', sourceColumn: 'q', expression: 'qty  *  PRICE' }] },
    ];
    const found = findDuplicateTransformations(ctx);
    assert.equal(found.length, 1);
  });

  it('same-shaped derivation under different names -> semantic_conflict', () => {
    const ctx = ctxWith(['portfolio_position', 'legacy_portfolio_value']);
    ctx.lineage.columns = [
      { sourceDataset: 'ibor_position', sourceColumn: 'position_qty', targetDataset: 'portfolio_position', targetColumn: 'market_value', expression: 'p.position_qty * s.close_price', statementId: 's1' },
      { sourceDataset: 'legacy_position', sourceColumn: 'pos_qty', targetDataset: 'legacy_portfolio_value', targetColumn: 'mv_amt', expression: 'l.pos_qty * px.px_adj', statementId: 's2' },
    ];
    const found = findSemanticConflicts(ctx);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.type, 'semantic_conflict');
  });
});
