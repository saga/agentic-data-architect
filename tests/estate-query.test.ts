import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyEstate, nodeId } from '../src/model/estate.js';
import {
  columnLineageRelations,
  datasetLineageRelations,
  downstreamDatasetRelations,
  incidentEdges,
  upstreamDatasetRelations,
} from '../src/model/estate-query.js';

describe('Data Estate graph queries', () => {
  it('centralizes dataset lineage traversal and incident evidence lookup', () => {
    const estate = emptyEstate();
    const sourceId = nodeId('dataset', 'raw_position');
    const targetId = nodeId('dataset', 'position');

    estate.nodes.push(
      { id: sourceId, type: 'dataset', name: 'raw_position', attributes: {} },
      { id: targetId, type: 'dataset', name: 'position', attributes: {} },
      { id: nodeId('dataset', 'portfolio_report'), type: 'dataset', name: 'portfolio_report', attributes: {} },
    );
    estate.edges.push(
      {
        id: 'e-1',
        from: sourceId,
        to: targetId,
        type: 'derived_from',
        evidenceIds: ['ev-raw-position'],
      },
      {
        id: 'e-2',
        from: targetId,
        to: nodeId('dataset', 'portfolio_report'),
        type: 'derived_from',
        evidenceIds: ['ev-position-report'],
      },
    );

    const relations = datasetLineageRelations(estate);
    assert.equal(relations.length, 2);
    assert.equal(relations[0]?.source.name, 'raw_position');
    assert.equal(relations[0]?.target.name, 'position');
    assert.deepEqual(
      upstreamDatasetRelations(estate, targetId).map((item) => item.source.name),
      ['raw_position'],
    );
    assert.deepEqual(
      downstreamDatasetRelations(estate, targetId).map((item) => item.target.name),
      ['portfolio_report'],
    );
    assert.deepEqual(
      incidentEdges(estate, targetId).flatMap((edge) => edge.evidenceIds),
      ['ev-raw-position', 'ev-position-report'],
    );
  });

  it('reads column lineage from the same canonical graph', () => {
    const estate = emptyEstate();
    const sourceId = nodeId('column', 'raw_position.pos_qty');
    const targetId = nodeId('column', 'position.quantity');

    estate.nodes.push(
      {
        id: sourceId,
        type: 'column',
        name: 'raw_position.pos_qty',
        attributes: { expression: 'pos_qty * 100' },
      },
      { id: targetId, type: 'column', name: 'position.quantity', attributes: {} },
    );
    estate.edges.push({
      id: 'e-col',
      from: sourceId,
      to: targetId,
      type: 'derived_from',
      evidenceIds: ['ev-column'],
    });

    const relations = columnLineageRelations(estate);
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.sourceDataset, 'raw_position');
    assert.equal(relations[0]?.sourceColumn, 'pos_qty');
    assert.equal(relations[0]?.targetDataset, 'position');
    assert.equal(relations[0]?.targetColumn, 'quantity');
    assert.equal(relations[0]?.expression, 'pos_qty * 100');
    assert.deepEqual(relations[0]?.edge.evidenceIds, ['ev-column']);
  });
});
