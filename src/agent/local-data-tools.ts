/**
 * Copilot Agent 的本地数据工具。
 *
 * 只暴露 catalog、register、describe、sample、profile、query 六个高价值操作。
 * Agent 不直接拿到 DuckDB 文件路径，也没有 ATTACH / COPY / INSTALL / LOAD 能力。
 */
import { defineTool } from '@github/copilot-sdk';
import * as z from 'zod';
import {
  discoverLocalDatasets,
  listLocalDatasets,
  localDescribe,
  localProfile,
  localQuery,
  localSample,
  localTransform,
  localExportParquet,
  registerLocalDataset,
} from '../analytics/local-data.js';

export function createLocalDataTools(sessionName: string) {
  return [
    defineTool('local_catalog', {
      description: '列出当前 Investigation workspace 中可分析的数据集。首次分析本地数据时优先调用。',
      parameters: z.object({
        refresh: z.boolean().optional().describe('是否重新扫描 workspace 中的 CSV、JSON、JSONL、Parquet 文件；默认会扫描。'),
      }),
      skipPermission: true,
      handler: async ({ refresh }) => ({
        datasets: refresh === false
          ? listLocalDatasets(sessionName)
          : await discoverLocalDatasets(sessionName),
      }),
    }),
    defineTool('local_register_dataset', {
      description: '把当前 Investigation workspace 内的 CSV、JSON、JSONL 或 Parquet 文件登记为数据集。',
      parameters: z.object({
        path: z.string().min(1).describe('相对当前 Investigation workspace 的文件路径。'),
        name: z.string().optional().describe('可选的数据集显示名称。'),
      }),
      skipPermission: true,
      handler: async ({ path, name }) => ({
        dataset: await registerLocalDataset(sessionName, path, name),
      }),
    }),
    defineTool('local_describe', {
      description: '查看已经登记的数据集字段和类型。先用 local_catalog 找到正确的数据集。',
      parameters: z.object({
        dataset: z.string().min(1),
      }),
      skipPermission: true,
      handler: async ({ dataset }) => localDescribe(sessionName, dataset),
    }),
    defineTool('local_sample', {
      description: '读取已经登记的数据集的一小部分真实数据，最多 100 行。',
      parameters: z.object({
        dataset: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      skipPermission: true,
      handler: async ({ dataset, limit }) => localSample(sessionName, dataset, limit ?? 20),
    }),
    defineTool('local_profile', {
      description: '对已经登记的数据集做确定性的列级 profiling，包括行数、空值比例、distinct 数量、最小值和最大值，并保存为 Evidence。',
      parameters: z.object({
        dataset: z.string().min(1),
      }),
      skipPermission: true,
      handler: async ({ dataset }) => localProfile(sessionName, dataset),
    }),
    defineTool('local_transform', {
      description: '在当前 Investigation 专属的 DuckDB 中生成分析表。只能由 SELECT 或 WITH 生成，目标只能是 analysis 或 scratch。',
      parameters: z.object({
        schema: z.enum(['analysis', 'scratch']),
        table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        sql: z.string().min(1),
        replace: z.boolean().optional(),
      }),
      skipPermission: true,
      handler: async ({ schema, table, sql, replace }) =>
        localTransform(sessionName, schema, table, sql, replace ?? true),
    }),
    defineTool('local_export_parquet', {
      description: '把一条只读 DuckDB 查询导出成 Parquet。输出只能写入当前 Investigation 的 exports/ 或 parquet/ 目录。',
      parameters: z.object({
        sql: z.string().min(1),
        path: z.string().min(1).regex(/^(exports|parquet)\//),
      }),
      handler: async ({ sql, path }) => localExportParquet(sessionName, sql, path),
    }),
    defineTool('local_query', {
      description: '在已经登记的数据集上执行一条只读 DuckDB SELECT 或 WITH 查询。结果最多返回 1000 行并保存为 Evidence。',
      parameters: z.object({
        sql: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      skipPermission: true,
      handler: async ({ sql, limit }) => localQuery(sessionName, sql, limit ?? 1000),
    }),
  ];
}
