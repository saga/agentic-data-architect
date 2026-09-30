/**
 * Data Estate Graph（§十）：统一实体/关系模型，JSON 实现，不上 Neo4j。
 * Discovery 输出 estate；Finding / mapping / architecture 都建在它上面。
 */
import { randomBytes } from 'node:crypto';

export type EstateNodeType =
  | 'system'
  | 'database'
  | 'schema'
  | 'dataset'
  | 'column'
  | 'file'
  | 'job'
  | 'report'
  | 'business_concept';

export interface EstateNode {
  id: string;
  type: EstateNodeType;
  name: string;
  attributes: Record<string, unknown>;
}

export type EstateRelationType =
  | 'contains'
  | 'reads_from'
  | 'writes_to'
  | 'derived_from'
  | 'transformed_by'
  | 'consumed_by'
  | 'implements'
  | 'mapped_to'
  | 'defined_by';

export interface EstateEdge {
  id: string;
  from: string;
  to: string;
  type: EstateRelationType;
  evidenceIds: string[];
}

export interface DataEstate {
  nodes: EstateNode[];
  edges: EstateEdge[];
}

export function emptyEstate(): DataEstate {
  return { nodes: [], edges: [] };
}

export function nodeId(type: EstateNodeType, name: string): string {
  return `${type}:${name.toLowerCase()}`;
}

/** estate 边 id（全局唯一，多 run 合并不碰撞）。 */
export function nextEstateId(): string {
  return `e-${randomBytes(4).toString('hex')}`;
}
