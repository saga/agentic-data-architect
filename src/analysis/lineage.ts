import fs from 'node:fs/promises';

/**
 * Lineage L1（dataset 级，§十六 Level 1）：A → B → C。
 * 实现：正则提取 FROM/JOIN 源表 + 输出目标（CREATE VIEW/TABLE AS / INSERT INTO）。
 * L2 列级 / L3 变换语义是 V2 的事，这里只输出“表从哪来、到哪去”，LLM 负责解释。
 */

export interface DatasetEdge {
  source: string;
  target: string;
  viaFile: string;
}

export interface LineageGraph {
  edges: DatasetEdge[];
  tables: string[];
}

const FROM_JOIN = /\b(?:from|join)\s+([a-zA-Z_][\w.]*)/gi;
const CREATE_AS = /create\s+(?:or\s+replace\s+)?(?:view|table)\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w.]*)/i;
const INSERT_INTO = /insert\s+(?:overwrite\s+)?(?:into\s+)?(?:table\s+)?([a-zA-Z_][\w.]*)/i;

export async function buildLineage(sqlFiles: string[]): Promise<LineageGraph> {
  const edges: DatasetEdge[] = [];
  const tables = new Set<string>();
  for (const file of sqlFiles) {
    const sql = await fs.readFile(file, 'utf-8');
    const target = extractTarget(sql) ?? fileLabel(file);
    tables.add(target);
    for (const src of extractSources(sql)) {
      tables.add(src);
      if (src.toLowerCase() !== target.toLowerCase()) {
        edges.push({ source: src, target, viaFile: file });
      }
    }
  }
  return { edges, tables: [...tables].sort() };
}

function extractTarget(sql: string): string | null {
  return CREATE_AS.exec(sql)?.[1] ?? INSERT_INTO.exec(sql)?.[1] ?? null;
}

function extractSources(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(FROM_JOIN)) {
    const name = m[1]?.replace(/;$/, '');
    if (name && !isKeyword(name)) out.add(name);
  }
  return [...out];
}

function isKeyword(name: string): boolean {
  return /^(select|where|lateral|unnest)$/i.test(name);
}

function fileLabel(file: string): string {
  const base = file.split('/').pop() ?? file;
  return `file:${base.replace(/\.sql$/i, '')}`;
}
