import fs from 'node:fs/promises';

/**
 * Profiling V1：只做文件级统计（行数/大小/引用表数）。
 * 真实 DB profiling（row count / null % / distinct %，见 §二十二）是 V1+ 的事，
 * 按“先 metadata 再定向查询”原则，接口预留在 adapters/（本次骨架不建目录）。
 */

export interface FileProfile {
  file: string;
  lines: number;
  sizeBytes: number;
  referencedTables: number;
}

export async function profileSqlFiles(files: string[], referencedCounts: Map<string, number>): Promise<FileProfile[]> {
  const out: FileProfile[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf-8');
    out.push({
      file,
      lines: raw.split('\n').length,
      sizeBytes: Buffer.byteLength(raw),
      referencedTables: referencedCounts.get(file) ?? 0,
    });
  }
  return out;
}
