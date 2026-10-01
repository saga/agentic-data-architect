/**
 * SQL 解析和 sqlglot bridge。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

/** 启动 Python sqlglot bridge，通过 stdin/stdout 与 Node 解析层交换批量 SQL 结果。 */
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

/** SQL AST 解析出的列级来源关系，支持 column lineage 的证据回溯。 */
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

/** 一个 SQL statement 的结构化解析结果，带文件和行号信息。 */
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

/** SQL parser 抽象契约，业务层不依赖 sqlglot 的具体实现。 */
export interface ParseFailure {
  statementIndex: number;
  error: string;
}

/**
 * SQL parser 抽象契约。
 *
 * parseFile 保持向后兼容；parseFileDetailed 额外暴露“哪些 statement 解析失败”，
 * 让 Current-State Discovery 不再静默吞掉坏 SQL。实现可以不提供 detailed 结果，业务层会回退。
 */
export interface SqlParser {
  parseFile(file: string, sql: string, dialect?: string): Promise<ParsedStatement[]>;
  parseFileDetailed?(file: string, sql: string, dialect?: string): Promise<{
    statements: ParsedStatement[];
    failures: ParseFailure[];
  }>;
}

/** 决定使用哪个 Python 解释器，优先项目配置和本地 .venv。 */
function resolvePython(): string {
  // 显式配置优先；否则使用项目级 .venv，避免依赖用户机器的全局 Python。
  if (process.env['SQLGLOT_PYTHON']) return process.env['SQLGLOT_PYTHON'];

  const localPython = process.platform === 'win32'
    ? path.resolve('.venv', 'Scripts', 'python.exe')
    : path.resolve('.venv', 'bin', 'python');

  if (existsSync(localPython)) return localPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 返回 sqlglot Python bridge 脚本路径。 */
function bridgeScript(): string {
  return path.resolve('scripts/sqlglot_parser.py');
}

/** SQL 顶层语句切分结果，仅用于确定 statement 对应的行号范围。 */
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

/** 基于 Python sqlglot bridge 的 SqlParser 实现，把 AST 结果转换为本项目统一结构。 */
export class SqlglotParser implements SqlParser {

  /** 解析整个 SQL 文件，并保留每个无法解析 statement 的错误。 */
  async parseFileDetailed(
    file: string,
    sql: string,
    dialect?: string,
  ): Promise<{ statements: ParsedStatement[]; failures: ParseFailure[] }> {
    const chunks = splitStatements(sql);
    if (chunks.length === 0) return { statements: [], failures: [] };
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

    const statements: ParsedStatement[] = [];
    const failures: ParseFailure[] = [];
    parsed.results.forEach((r, i) => {
      if (r.error || !r.statements) {
        failures.push({
          statementIndex: i,
          error: r.error || 'SQL parser 没有返回这个语句的解析结果',
        });
        return;
      }
      r.statements.forEach((s, j) => {
        statements.push({
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
    return { statements, failures };
  }

  /** 解析一个 SQL 文件，单条解析失败时跳过该 statement，避免污染整份文件。 */
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
