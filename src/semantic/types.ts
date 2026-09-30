/**
 * Semantic Context 的通用类型。
 *
 * Snowflake Semantic View 是一个 provider，而不是核心领域模型。
 * Data Product、dbt、Catalog、BI 或其他语义系统都可以转换成这里的结构。
 */
export type SemanticAssetKind =
  | 'semantic_view'
  | 'data_product'
  | 'catalog_term'
  | 'metric'
  | 'verified_query'
  | 'dashboard';

export interface SemanticAsset {
  id: string;
  kind: SemanticAssetKind;
  provider: string;
  name: string;
  qualifiedName?: string;
  description?: string;
  uri?: string;
  attributes?: Record<string, unknown>;
  evidenceIds?: string[];
}

/**
 * Semantic provider 的最小契约。
 *
 * 核心 workflow 只依赖这个接口，不依赖厂商 SDK。
 */
export interface SemanticContextProvider {
  readonly type: string;
  discover(scope?: string): Promise<SemanticAsset[]>;
}
