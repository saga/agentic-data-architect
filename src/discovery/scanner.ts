import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Discovery V1：只扫本地目录（§三十一：Git / SQL / ETL → Inventory）。
 * DB 直连（§二十二要求先 metadata 后全扫）留作 adapter 接口，不在 V1 实现。
 */

export interface SourceFile {
  path: string;
  kind: 'sql' | 'python' | 'doc' | 'other';
  sizeBytes: number;
}

export interface Inventory {
  root: string;
  scannedAt: string;
  files: SourceFile[];
  sqlFiles: string[];
  unknowns: string[];
}

const SQL_EXT = new Set(['.sql']);
const PY_EXT = new Set(['.py', '.pyw']);
const DOC_EXT = new Set(['.md', '.txt', '.rst']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.data', '__pycache__']);

export async function discoverDirectory(root: string): Promise<Inventory> {
  const abs = path.resolve(root);
  const files: SourceFile[] = [];
  const unknowns: string[] = [];
  await walk(abs, files);
  const sqlFiles = files.filter((f) => f.kind === 'sql').map((f) => f.path);
  if (sqlFiles.length === 0) unknowns.push('No .sql files found under ' + abs);
  return { root: abs, scannedAt: new Date().toISOString(), files, sqlFiles, unknowns };
}

async function walk(dir: string, out: SourceFile[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), out);
      continue;
    }
    const fp = path.join(dir, e.name);
    const ext = path.extname(e.name).toLowerCase();
    const stat = await fs.stat(fp);
    out.push({
      path: fp,
      kind: SQL_EXT.has(ext) ? 'sql' : PY_EXT.has(ext) ? 'python' : DOC_EXT.has(ext) ? 'doc' : 'other',
      sizeBytes: stat.size,
    });
  }
}
