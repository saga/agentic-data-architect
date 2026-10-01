/**
 * SQL AST 驱动的 lineage 构建。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import fs from 'node:fs/promises';
import { nextId, type EvidenceRef } from '../evidence/types.js';
import { SqlglotParser, splitStatements, type ColumnLineage, type ParsedStatement, type ParseFailure } from './sql-parser.js';

/**
 * Lineage（AST 驱动，§十六）：L1 dataset + L2 column。
 * 正则已删除。每个 statement 发射 sql_statement 证据，每条边发射 lineage 证据，
 * 全部绑定 file + 行号 + 源 hash + discoveryRun，便于过期判定。
 */

export interface DatasetEdge {
  source: string;
  target: string;
  viaFile: string;
  evidenceId: string;
}

/** 一次 SQL lineage 分析的完整结果，包括表、列、statement 和 Evidence。 */
export interface LineageGraph {
  edges: DatasetEdge[];
  tables: string[];
  columns: ColumnLineage[];
  statements: ParsedStatement[];
  parseFailures: { file: string; statementIndex: number; lineStart: number; lineEnd: number; error: string }[];
  evidence: EvidenceRef[];
}

/** 构建 lineage 所需的输入文件及其源指纹。 */
export interface LineageInput {
  path: string;
  sha256: string;
  investigationId: string;
  discoveryRunId: string;
  dialect?: string;
}

/** 批量解析 SQL 文件，生成 dataset/column lineage，并为每个结论创建可追溯 Evidence。 */
export async function buildLineage(inputs: LineageInput[], parser = new SqlglotParser()): Promise<LineageGraph> {
  const edges: DatasetEdge[] = [];
  const tables = new Set<string>();
  const columns: ColumnLineage[] = [];
  const statements: ParsedStatement[] = [];
  const parseFailures: { file: string; statementIndex: number; lineStart: number; lineEnd: number; error: string }[] = [];
  const evidence: EvidenceRef[] = [];
  const seenEdge = new Set<string>();

  for (const input of inputs) {
    const sql = await fs.readFile(input.path, 'utf-8');
    const chunks = splitStatements(sql);
    const detailed: { statements: ParsedStatement[]; failures: ParseFailure[] } = parser.parseFileDetailed
      ? await parser.parseFileDetailed(input.path, sql, input.dialect)
      : {
          statements: await parser.parseFile(input.path, sql, input.dialect),
          failures: [],
        };
    const parsed = detailed.statements;
    const detailedFailures = detailed.failures;
    const failureByIndex = new Map<number, ParseFailure>(
      detailedFailures.map((failure: ParseFailure) => [failure.statementIndex, failure]),
    );
    const parsedIndexes = new Set<number>(parsed.map((st: ParsedStatement) => st.statementIndex));
    chunks.forEach((chunk, statementIndex) => {
      if (parsedIndexes.has(statementIndex)) return;
      const parserFailure = failureByIndex.get(statementIndex);
      const failure = {
        file: input.path,
        statementIndex,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        error: parserFailure?.error ?? 'SQL parser 没有返回这个语句的解析结果',
      };
      parseFailures.push(failure);
      evidence.push({
        id: nextId('ev'),
        type: 'parse_failure',
        investigationId: input.investigationId,
        discoveryRunId: input.discoveryRunId,
        source: input.path + ':' + chunk.lineStart + '-' + chunk.lineEnd,
        file: input.path,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        sourceHash: input.sha256,
        value: { statementIndex, error: failure.error },
        collectedAt: new Date().toISOString(),
      });
    });
    for (const st of parsed) {
      statements.push(st);
      const stmtEvidence: EvidenceRef = {
        id: nextId('ev'),
        type: 'sql_statement',
        investigationId: input.investigationId,
        discoveryRunId: input.discoveryRunId,
        source: `${input.path}:${st.lineStart}-${st.lineEnd}`,
        file: input.path,
        lineStart: st.lineStart,
        lineEnd: st.lineEnd,
        statement: sql.split('\n').slice(st.lineStart - 1, st.lineEnd).join('\n').slice(0, 2000),
        ...(st.target ? { dataset: st.target } : {}),
        sourceHash: input.sha256,
        collectedAt: new Date().toISOString(),
      };
      evidence.push(stmtEvidence);

      const target = st.target ?? `file:${input.path.split('/').pop()?.replace(/\.sql$/i, '')}`;
      tables.add(target);
      for (const src of st.sources) {
        tables.add(src);
        const key = `${src.toLowerCase()}→${target.toLowerCase()}`;
        if (src.toLowerCase() === target.toLowerCase() || seenEdge.has(key)) continue;
        seenEdge.add(key);
        const edgeEvidence: EvidenceRef = {
          id: nextId('ev'),
          type: 'lineage',
          investigationId: input.investigationId,
          discoveryRunId: input.discoveryRunId,
          source: `${src} → ${target} (${input.path}:${st.lineStart}-${st.lineEnd})`,
          file: input.path,
          lineStart: st.lineStart,
          lineEnd: st.lineEnd,
          dataset: target,
          sourceHash: input.sha256,
          collectedAt: new Date().toISOString(),
        };
        evidence.push(edgeEvidence);
        edges.push({ source: src, target, viaFile: input.path, evidenceId: edgeEvidence.id });
      }
      for (const c of st.columns) {
        columns.push({ ...c, targetDataset: target, statementId: st.id, evidenceId: stmtEvidence.id });
      }
    }
  }
  return { edges, tables: [...tables].sort(), columns, statements, parseFailures, evidence };
}
