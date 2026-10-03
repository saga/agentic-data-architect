import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentStateIntelligence } from '../src/analysis/current-state.js';
import { emptyEstate, nodeId } from '../src/model/estate.js';

describe('Current-State Intelligence', () => {
  it('builds source and semantic candidates without treating them as business truth', () => {
    const estate = emptyEstate();

    estate.nodes.push(
      { id: nodeId('dataset', 'prod.ibor_position'), type: 'dataset', name: 'prod.ibor_position', attributes: { adapter: 'snowflake' } },
      { id: nodeId('dataset', 'prod.position_snapshot'), type: 'dataset', name: 'prod.position_snapshot', attributes: { adapter: 'snowflake' } },
      { id: nodeId('column', 'prod.ibor_position.security_id'), type: 'column', name: 'prod.ibor_position.security_id', attributes: {} },
      { id: nodeId('column', 'prod.ibor_position.position_qty'), type: 'column', name: 'prod.ibor_position.position_qty', attributes: {} },
      { id: nodeId('column', 'prod.ibor_position.as_of_date'), type: 'column', name: 'prod.ibor_position.as_of_date', attributes: {} },
    );

    const lineage = {
      edges: [
        { source: 'prod.ibor_position', target: 'prod.portfolio_position', viaFile: 'a.sql', evidenceId: 'ev-1' },
        { source: 'prod.position_snapshot', target: 'prod.report', viaFile: 'b.sql', evidenceId: 'ev-2' },
      ],
      tables: ['prod.ibor_position', 'prod.portfolio_position', 'prod.position_snapshot', 'prod.report'],
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
    assert.ok(result.sourceOfTruthCandidates.some((item) => item.key === 'ibor_position'));
    assert.ok(result.semanticCandidates.some((item) => item.key === 'position' && item.semanticAssets.includes('sv:position')));
  });
});
