import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentStateIntelligence } from '../src/analysis/current-state.js';
import { emptyEstate, nodeId } from '../src/model/estate.js';

describe('Current-State Intelligence', () => {
  it('builds source and semantic candidates without treating them as business truth', () => {
    const estate = emptyEstate();

    estate.nodes.push(
      { id: nodeId('dataset', 'stg_position'), type: 'dataset', name: 'stg_position', attributes: { adapter: 'snowflake' } },
      { id: nodeId('dataset', 'raw_position'), type: 'dataset', name: 'raw_position', attributes: { adapter: 'snowflake' } },
      { id: nodeId('column', 'stg_position.security_id'), type: 'column', name: 'stg_position.security_id', attributes: {} },
      { id: nodeId('column', 'stg_position.position_qty'), type: 'column', name: 'stg_position.position_qty', attributes: {} },
      { id: nodeId('column', 'stg_position.as_of_date'), type: 'column', name: 'stg_position.as_of_date', attributes: {} },
    );

    const lineage = {
      edges: [
        { source: 'stg_position', target: 'prod.portfolio_position', viaFile: 'a.sql', evidenceId: 'ev-1' },
        { source: 'raw_position', target: 'prod.report', viaFile: 'b.sql', evidenceId: 'ev-2' },
      ],
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
