/**
 * Data Estate Graph（§十）：统一实体/关系模型，JSON 实现，不上 Neo4j。
 * Discovery 输出 estate；Finding / mapping / architecture 都建在它上面。
 */
import { randomBytes } from 'node:crypto';

/** Data Estate 节点类型；统一描述系统、数据库、表、列、文件等资产。 */
export type EstateNodeType =
  | 'system'
  | 'application'
  | 'interface'
  | 'database'
  | 'schema'
  | 'data_store'
  | 'dataset'
  | 'column'
  | 'file'
  | 'api'
  | 'message_topic'
  | 'job'
  | 'job_run'
  | 'report'
  | 'dashboard'
  | 'business_concept';

/** Data Estate 中一个实体节点。attributes 保留来源适配器等扩展信息。 */
export interface EstateNode {
  id: string;
  type: EstateNodeType;
  name: string;
  attributes: Record<string, unknown>;
}

/** Data Estate 边的关系类型，例如 contains、derived_from、writes_to。 */
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

/** 两个 Estate 节点之间的关系，并记录支撑该关系的 Evidence。 */
export interface EstateEdge {
  id: string;
  from: string;
  to: string;
  type: EstateRelationType;
  evidenceIds: string[];
  relationMode?: 'static' | 'runtime' | 'semantic';
  expression?: string;
}

/** 一次 Discovery 得到的统一数据资产图，包含节点和关系。 */
export interface DataEstate {
  nodes: EstateNode[];
  edges: EstateEdge[];
}

/** 创建空的 Data Estate，供目录和数据库 Discovery 逐步合并结果。 */
export function emptyEstate(): DataEstate {
  return { nodes: [], edges: [] };
}

/** 根据节点类型和名称生成稳定 ID，让多来源 Discovery 可以去重合并。 */
export function nodeId(type: EstateNodeType, name: string): string {
  return `${type}:${name.toLowerCase()}`;
}

/** estate 边 id（全局唯一，多 run 合并不碰撞）。 */
export function nextEstateId(): string {
  return `e-${randomBytes(4).toString('hex')}`;
}
