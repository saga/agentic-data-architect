import { spawn } from 'node:child_process';
import path from 'node:path';

function execBridge(python: string, script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.length > 64 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`parser bridge exited ${code}${stderr ? ` stderr: ${stderr.slice(0, 500)}` : ''}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/** 桥脚本版本（discoveryRun 记录用，换 parser / 升级 sqlglot 要能看出来）。 */
export const PARSER_VERSION = 'sqlglot-bridge@1';

export interface ColumnLineage {
  sourceDataset: string;
  sourceColumn: string;
  targetDataset: string;
  targetColumn: string;
  expression?: string;
  statementId: string;
  /** 对应 SQL statement evidence，便于列级结论回指原始 SQL。 */
  evidenceId?: string;
}

export interface ParsedStatement {
  id: string;
  file: string;
  statementIndex: number;
  lineStart: number;
  lineEnd: number;
  target?: string;
  sources: string[];
  columns: Omit<ColumnLineage, 'statementId' | 'targetDataset' | 'evidenceId'>[];
  dialect?: string;
}

export interface SqlParser {
  parseFile(file: string, sql: string, dialect?: string): Promise<ParsedStatement[]>;
}

function resolvePython(): string {
  // SQLGLOT_PYTHON 指向装了 sqlglot 的解释器（pip install sqlglot）。
  // 本机多 Python 时必须指对，桥接报错会直接告诉你当前用的是哪个。
  return process.env['SQLGLOT_PYTHON'] ?? 'python3';
}

function bridgeScript(): string {
  return path.resolve('scripts/sqlglot_parser.py');
}

export interface SplitStatement {
  sql: string;
  lineStart: number;
  lineEnd: number;
}

/** 按顶层分号切分（跳过字符串与注释），只用于定位行号，不参与语义解析。 */
export function splitStatements(text: string): SplitStatement[] {
  const out: SplitStatement[] = [];
  let start = 0;
  let startLine = 1;
  let line = 1;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  const push = (end: number, endLine: number) => {
    const sql = text.slice(start, end).trim();
    if (sql) out.push({ sql, lineStart: startLine, lineEnd: endLine });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') line++;
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '-' && next === '-') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === ';') {
      push(i, line);
      start = i + 1;
      startLine = line;
    }
  }
  push(text.length, line);
  return out;
}

interface BridgeColumn {
  targetColumn: string;
  sourceDataset: string;
  sourceColumn: string;
  expression: string;
}

interface BridgeStatement {
  target: string | null;
  kind: string;
  sources: string[];
  columns: BridgeColumn[];
  sql: string;
}

export class SqlglotParser implements SqlParser {
  async parseFile(file: string, sql: string, dialect?: string): Promise<ParsedStatement[]> {
    const chunks = splitStatements(sql);
    if (chunks.length === 0) return [];
    const payload = JSON.stringify({
      batch: chunks.map((c) => ({ sql: c.sql, ...(dialect ? { dialect } : {}) })),
    });
    let stdout: string;
    try {
      stdout = await execBridge(resolvePython(), bridgeScript(), payload);
    } catch (e) {
      throw new Error(
        `SQL parser bridge failed (python=${resolvePython()}). ` +
          `Need sqlglot on that interpreter: pip install sqlglot. Cause: ${e instanceof Error ? e.message : e}`,
      );
    }
    const parsed = JSON.parse(stdout) as { results?: { statements: BridgeStatement[]; error: string | null }[] };
    if (!parsed.results) throw new Error(`SQL parser bridge bad output: ${stdout.slice(0, 200)}`);
    const out: ParsedStatement[] = [];
    parsed.results.forEach((r, i) => {
      if (r.error || !r.statements) return; // 单条失败跳过，不污染整文件
      r.statements.forEach((s, j) => {
        out.push({
          id: `${file}#${i}${r.statements.length > 1 ? `.${j}` : ''}`,
          file,
          statementIndex: i,
          lineStart: chunks[i]?.lineStart ?? 1,
          lineEnd: chunks[i]?.lineEnd ?? 1,
          ...(s.target ? { target: s.target } : {}),
          sources: s.sources,
          columns: s.columns,
          ...(dialect ? { dialect } : {}),
        });
      });
    });
    return out;
  }
}
