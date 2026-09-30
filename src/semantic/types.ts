/**
 * Semantic Context 的通用类型和运行时 Schema。
 *
 * Snowflake Semantic View 是一个 provider，而不是核心领域模型。
 * Data Product、dbt、Catalog、BI 或其他语义系统都可以转换成这里的结构。
 */
import * as z from 'zod';

export const SemanticAssetKindSchema = z.enum([
  'semantic_view',
  'data_product',
  'catalog_term',
  'metric',
  'verified_query',
  'dashboard',
]);
export type SemanticAssetKind = z.infer<typeof SemanticAssetKindSchema>;

export const SemanticAssetSchema = z.object({
  id: z.string().min(1),
  kind: SemanticAssetKindSchema,
  provider: z.string().min(1),
  name: z.string().min(1),
  qualifiedName: z.string().optional(),
  description: z.string().optional(),
  uri: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  evidenceIds: z.array(z.string()).optional(),
}).strict();
export type SemanticAsset = z.infer<typeof SemanticAssetSchema>;

export const SemanticAssetListSchema = z.array(SemanticAssetSchema);

/**
 * Semantic provider 的最小契约。
 *
 * 核心 workflow 只依赖这个接口，不依赖厂商 SDK。
 */
export interface SemanticContextProvider {
  readonly type: string;
  discover(scope?: string): Promise<SemanticAsset[]>;
}