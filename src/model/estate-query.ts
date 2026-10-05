/**
 * Data Estate graph queries.
 *
 * DataEstate remains the canonical graph model. These helpers only centralize
 * repeated traversal/query logic; they do not introduce another catalog model.
 */
import type {
  DataEstate,
  EstateEdge,
  EstateNode,
  EstateNodeType,
} from './estate.js';

export interface DatasetLineageRelation {
  edge: EstateEdge;
  source: EstateNode;
  target: EstateNode;
}

export interface ColumnLineageRelation {
  edge: EstateEdge;
  source: EstateNode;
  target: EstateNode;
  sourceDataset: string;
  sourceColumn: string;
  targetDataset: string;
  targetColumn: string;
  expression?: string;
}

/** Return all nodes of one Estate type. */
export function nodesOfType(estate: DataEstate, type: EstateNodeType): EstateNode[] {
  return estate.nodes.filter((node) => node.type === type);
}

/** Find a node by its canonical Estate id. */
export function findNode(estate: DataEstate, id: string): EstateNode | undefined {
  return estate.nodes.find((node) => node.id === id);
}

/** Find a node by type and case-insensitive display name. */
export function findNodeByName(
  estate: DataEstate,
  type: EstateNodeType,
  name: string,
): EstateNode | undefined {
  const lower = name.toLowerCase();
  return estate.nodes.find((node) => node.type === type && node.name.toLowerCase() === lower);
}

/** Return edges whose type matches the requested relation. */
export function edgesOfType(estate: DataEstate, type: EstateEdge['type']): EstateEdge[] {
  return estate.edges.filter((edge) => edge.type === type);
}

/** Return edges leaving a node, optionally restricted by relation type. */
export function edgesFrom(
  estate: DataEstate,
  nodeId: string,
  type?: EstateEdge['type'],
): EstateEdge[] {
  return estate.edges.filter(
    (edge) => edge.from === nodeId && (type === undefined || edge.type === type),
  );
}

/** Return edges entering a node, optionally restricted by relation type. */
export function edgesTo(
  estate: DataEstate,
  nodeId: string,
  type?: EstateEdge['type'],
): EstateEdge[] {
  return estate.edges.filter(
    (edge) => edge.to === nodeId && (type === undefined || edge.type === type),
  );
}

/** Return every edge incident to a node. */
export function incidentEdges(estate: DataEstate, nodeId: string): EstateEdge[] {
  return estate.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
}

/**
 * Return dataset-to-dataset lineage relations represented by DataEstate's
 * derived_from edges.
 */
export function datasetLineageRelations(estate: DataEstate): DatasetLineageRelation[] {
  const nodeById = new Map(estate.nodes.map((node) => [node.id, node]));
  return estate.edges
    .filter((edge) => edge.type === 'derived_from')
    .map((edge) => ({
      edge,
      source: nodeById.get(edge.from),
      target: nodeById.get(edge.to),
    }))
    .filter(
      (item): item is DatasetLineageRelation =>
        item.source?.type === 'dataset' && item.target?.type === 'dataset',
    );
}

/** Return the datasets directly upstream from a dataset. */
export function upstreamDatasetRelations(
  estate: DataEstate,
  datasetId: string,
): DatasetLineageRelation[] {
  return datasetLineageRelations(estate).filter((relation) => relation.target.id === datasetId);
}

/** Return the datasets directly downstream from a dataset. */
export function downstreamDatasetRelations(
  estate: DataEstate,
  datasetId: string,
): DatasetLineageRelation[] {
  return datasetLineageRelations(estate).filter((relation) => relation.source.id === datasetId);
}

/**
 * Return column-to-column lineage relations represented by DataEstate.
 *
 * The source column node stores the parsed transformation expression because
 * EstateEdge deliberately stays focused on graph/evidence identity.
 */
export function columnLineageRelations(estate: DataEstate): ColumnLineageRelation[] {
  const nodeById = new Map(estate.nodes.map((node) => [node.id, node]));
  return estate.edges
    .filter((edge) => edge.type === 'derived_from')
    .map((edge) => ({
      edge,
      source: nodeById.get(edge.from),
      target: nodeById.get(edge.to),
    }))
    .filter(
      (item): item is { edge: EstateEdge; source: EstateNode; target: EstateNode } =>
        item.source?.type === 'column' && item.target?.type === 'column',
    )
    .map(({ edge, source, target }) => {
      const sourceDot = source.name.lastIndexOf('.');
      const targetDot = target.name.lastIndexOf('.');
      const sourceDataset = sourceDot > 0 ? source.name.slice(0, sourceDot) : source.name;
      const sourceColumn = sourceDot > 0 ? source.name.slice(sourceDot + 1) : source.name;
      const targetDataset = targetDot > 0 ? target.name.slice(0, targetDot) : target.name;
      const targetColumn = targetDot > 0 ? target.name.slice(targetDot + 1) : target.name;
      const attributes = source.attributes as { expression?: unknown };
      const expression = edge.expression
        ?? (typeof attributes.expression === 'string' ? attributes.expression : undefined);

      return {
        edge,
        source,
        target,
        sourceDataset,
        sourceColumn,
        targetDataset,
        targetColumn,
        ...(expression ? { expression } : {}),
      };
    });
}
