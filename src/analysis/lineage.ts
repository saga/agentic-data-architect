import fs from 'node:fs/promises';
import { nextId, type EvidenceRef } from '../evidence/types.js';
import { SqlglotParser, type ColumnLineage, type ParsedStatement } from './sql-parser.js';

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

export interface LineageGraph {
  edges: DatasetEdge[];
  tables: string[];
  columns: ColumnLineage[];
  statements: ParsedStatement[];
  evidence: EvidenceRef[];
}

export interface LineageInput {
  path: string;
  sha256: string;
  investigationId: string;
  discoveryRunId: string;
  dialect?: string;
}

export async function buildLineage(inputs: LineageInput[], parser = new SqlglotParser()): Promise<LineageGraph> {
  const edges: DatasetEdge[] = [];
  const tables = new Set<string>();
  const columns: ColumnLineage[] = [];
  const statements: ParsedStatement[] = [];
  const evidence: EvidenceRef[] = [];
  const seenEdge = new Set<string>();

  for (const input of inputs) {
    const sql = await fs.readFile(input.path, 'utf-8');
    const parsed = await parser.parseFile(input.path, sql, input.dialect);
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
  return { edges, tables: [...tables].sort(), columns, statements, evidence };
}
