import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Discovery V1.1：本地目录扫描 + 源指纹。
 * 每个文件带 sha256/modifiedAt/lineCount，Evidence 可精确绑定到“当时分析的是哪个版本”。
 */

export interface SourceFile {
  path: string;
  kind: 'sql' | 'python' | 'doc' | 'yaml' | 'json' | 'other';
  sizeBytes: number;
  lineCount: number;
  modifiedAt: string;
  sha256: string;
}

export interface Inventory {
  root: string;
  discoveryRunId: string;
  scannedAt: string;
  files: SourceFile[];
  sqlFiles: string[];
  unknowns: string[];
}

const SQL_EXT = new Set(['.sql']);
const PY_EXT = new Set(['.py', '.pyw']);
const DOC_EXT = new Set(['.md', '.txt', '.rst']);
const YAML_EXT = new Set(['.yml', '.yaml']);
const JSON_EXT = new Set(['.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.data', '__pycache__']);

export async function discoverDirectory(root: string, discoveryRunId: string): Promise<Inventory> {
  const abs = path.resolve(root);
  const files: SourceFile[] = [];
  const unknowns: string[] = [];
  await walk(abs, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const sqlFiles = files.filter((f) => f.kind === 'sql').map((f) => f.path);
  if (sqlFiles.length === 0) unknowns.push(`No .sql files found under ${abs}`);
  return { root: abs, discoveryRunId, scannedAt: new Date().toISOString(), files, sqlFiles, unknowns };
}

async function walk(dir: string, out: SourceFile[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), out);
      continue;
    }
    if (e.isSymbolicLink()) continue;
    const fp = path.join(dir, e.name);
    const ext = path.extname(e.name).toLowerCase();
    const [stat, raw] = await Promise.all([fs.stat(fp), fs.readFile(fp)]);
    out.push({
      path: fp,
      kind: SQL_EXT.has(ext)
        ? 'sql'
        : PY_EXT.has(ext)
          ? 'python'
          : DOC_EXT.has(ext)
            ? 'doc'
            : YAML_EXT.has(ext)
              ? 'yaml'
              : JSON_EXT.has(ext)
                ? 'json'
                : 'other',
      sizeBytes: stat.size,
      lineCount: raw.length === 0 ? 0 : raw.toString('utf-8').split('\n').length,
      modifiedAt: stat.mtime.toISOString(),
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
  }
}
