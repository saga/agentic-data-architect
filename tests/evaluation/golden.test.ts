import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildLineage } from '../../src/analysis/lineage.js';
import { discoverDirectory } from '../../src/discovery/scanner.js';
import { runAllFindings } from '../../src/analysis/findings.js';

/**
 * Golden benchmark（docs/evaluation.md）：
 *  - lineage precision / recall（边 + 列）
 *  - findings 类型覆盖
 *  - unsupported claim 防线：模型谎称 verified 且无证据 → 校正为 unknown
 */
import { parseAgentAnswer } from '../../src/agent/result.js';

const GOLDEN = path.resolve('examples/investment/golden');

describe('golden: lineage precision/recall', () => {
  it('dataset edges and column edges match expected', async () => {
    const inv = await discoverDirectory(path.join(GOLDEN, 'legacy'), 'run-golden');
    const g = await buildLineage(
      inv.files.filter((f) => f.kind === 'sql').map((f) => ({
        path: f.path,
        sha256: f.sha256,
        investigationId: 'golden',
        discoveryRunId: 'run-golden',
      })),
    );
    const expected = JSON.parse(readFileSync(path.join(GOLDEN, 'expected/lineage.json'), 'utf-8')) as {
      edges: [string, string][];
      columns: [string, string][];
    };
    const gotEdges = new Set(g.edges.map((e) => `${e.source.toLowerCase()}→${e.target.toLowerCase()}`));
    const wantEdges = new Set(expected.edges.map(([s, t]) => `${s.toLowerCase()}→${t.toLowerCase()}`));
    const tp = [...wantEdges].filter((e) => gotEdges.has(e));
    const precision = tp.length / gotEdges.size;
    const recall = tp.length / wantEdges.size;
    assert.ok(precision >= 1, `edge precision ${precision}, extra: ${[...gotEdges].filter((e) => !wantEdges.has(e))}`);
    assert.ok(recall >= 1, `edge recall ${recall}, missing: ${[...wantEdges].filter((e) => !gotEdges.has(e))}`);

    const gotCols = new Set(
      g.columns.map((c) => `${c.sourceDataset.toLowerCase()}.${c.sourceColumn.toLowerCase()}→${c.targetColumn.toLowerCase()}`),
    );
    for (const [src, tgt] of expected.columns) {
      const [sds, scol] = src.split('.') as [string, string];
      const tgtCol = tgt.split('.').pop() as string;
      assert.ok(
        [...gotCols].some((k) => k.startsWith(`${sds.toLowerCase()}.${scol.toLowerCase()}→`) && k.endsWith(`→${tgtCol.toLowerCase()}`)),
        `missing column edge ${src} → ${tgt}`,
      );
    }
  });
});

describe('golden: findings coverage', () => {
  it('expected finding types are all detected', async () => {
    const inv = await discoverDirectory(path.join(GOLDEN, 'legacy'), 'run-golden');
    const g = await buildLineage(
      inv.files.filter((f) => f.kind === 'sql').map((f) => ({
        path: f.path,
        sha256: f.sha256,
        investigationId: 'golden',
        discoveryRunId: 'run-golden',
      })),
    );
    const found = runAllFindings({ investigationId: 'golden', lineage: g, profiles: [], inventory: inv, evidence: g.evidence });
    const expected = JSON.parse(readFileSync(path.join(GOLDEN, 'expected/findings.json'), 'utf-8')) as {
      findingTypes: string[];
    };
    const got = new Set(found.map((f) => f.type));
    for (const t of expected.findingTypes) {
      assert.ok(got.has(t), `missing finding type ${t} (got: ${[...got]})`);
    }
  });
});

describe('unsupported claim rate guard', () => {
  it('model claiming verified with no evidence is calibrated to unknown', () => {
    const raw = JSON.stringify({
      answer: 'IBOR is definitely the source of truth.',
      claims: [{ claim: 'IBOR is the source of truth', status: 'verified', evidenceIds: [] }],
      unknowns: [],
      followUpQuestions: [],
    });
    const p = parseAgentAnswer(raw, new Set());
    assert.equal(p.claims[0]?.status, 'unknown');
  });
});
