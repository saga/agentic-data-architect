import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentStateIntelligence } from '../src/analysis/current-state.js';
import { emptyEstate, nodeId } from '../src/model/estate.js';

describe('Current-State Intelligence', () => {
  it('builds source and semantic candidates without treating them as business truth', () => {
    const estate = emptyEstate();

    const stgPositionId = nodeId('dataset', 'stg_position');
    const rawPositionId = nodeId('dataset', 'raw_position');
    const portfolioPositionId = nodeId('dataset', 'prod.portfolio_position');
    const reportId = nodeId('dataset', 'prod.report');

    estate.nodes.push(
      { id: stgPositionId, type: 'dataset', name: 'stg_position', attributes: { adapter: 'snowflake' } },
      { id: rawPositionId, type: 'dataset', name: 'raw_position', attributes: { adapter: 'snowflake' } },
      { id: portfolioPositionId, type: 'dataset', name: 'prod.portfolio_position', attributes: {} },
      { id: reportId, type: 'dataset', name: 'prod.report', attributes: {} },
      { id: nodeId('column', 'stg_position.security_id'), type: 'column', name: 'stg_position.security_id', attributes: {} },
      { id: nodeId('column', 'stg_position.position_qty'), type: 'column', name: 'stg_position.position_qty', attributes: {} },
      { id: nodeId('column', 'stg_position.as_of_date'), type: 'column', name: 'stg_position.as_of_date', attributes: {} },
    );
    estate.edges.push(
      {
        id: 'e-1',
        from: stgPositionId,
        to: portfolioPositionId,
        type: 'derived_from',
        evidenceIds: ['ev-1'],
      },
      {
        id: 'e-2',
        from: rawPositionId,
        to: reportId,
        type: 'derived_from',
        evidenceIds: ['ev-2'],
      },
    );

    const lineage = {
      // Graph traversal is deliberately empty here: Current-State must use the
      // canonical DataEstate rather than re-querying LineageGraph.edges.
      edges: [],
      tables: ['stg_position', 'prod.portfolio_position', 'raw_position', 'prod.report'],
      columns: [],
      statements: [],
      parseFailures: [],
      evidence: [],
    };

    const result = buildCurrentStateIntelligence({
      inventory: {
        root: '/tmp',
        discoveryRunId: 'run-1',
        scannedAt: new Date().toISOString(),
        files: [],
        sqlFiles: ['a.sql', 'b.sql'],
        unknowns: [],
      },
      estate,
      lineage,
      profiles: [],
      semanticAssets: [
        { id: 'sv:position', kind: 'semantic_view', provider: 'snowflake', name: 'Position', description: 'Portfolio positions' },
      ],
    });

    assert.equal(result.coverage.sqlParseFailures, 0);
    assert.equal(result.coverage.datasetLineageConnectionRate, 1);
    assert.ok(result.sourceOfTruthCandidates.some((item) => item.key === 'position'));
    assert.ok(result.semanticCandidates.some((item) => item.key === 'position' && item.semanticAssets.includes('sv:position')));
  });
});


test('does not invent a source-of-truth candidate for a uniquely named dataset', () => {
  const estate = emptyEstate();
  estate.nodes.push({
    id: nodeId('dataset', 'prod.unique_position'),
    type: 'dataset',
    name: 'prod.unique_position',
    attributes: { adapter: 'snowflake' },
  });

  const result = buildCurrentStateIntelligence({
    inventory: {
      root: '/tmp',
      discoveryRunId: 'run-2',
      scannedAt: new Date().toISOString(),
      files: [],
      sqlFiles: [],
      unknowns: [],
    },
    estate,
    lineage: null,
    profiles: [],
    semanticAssets: [],
  });

  assert.deepEqual(result.sourceOfTruthCandidates, []);
});
