import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJourneyMarkdown } from './journey.js';
import { config } from '../config.js';

const explicitFiles = process.argv.slice(2);

async function workflowFiles(): Promise<string[]> {
  if (explicitFiles.length) return explicitFiles;

  const entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(config.skillsDir, entry.name, 'SKILL.md');
    try {
      const markdown = await fs.readFile(file, 'utf8');
      if (/^##\s+@flow\s+/m.test(markdown)) files.push(file);
    } catch {
      // 不是 Workflow Skill 的目录不需要检查。
    }
  }
  return files.sort();
}

let failed = false;

try {
  const files = await workflowFiles();
  if (!files.length) {
    console.error('ERROR 没有找到 Markdown Workflow');
    process.exitCode = 1;
  }

  for (const file of files) {
    const markdown = await fs.readFile(file, 'utf8');
    const result = parseJourneyMarkdown(markdown);
    if (result.issues.length) {
      failed = true;
      for (const issue of result.issues) {
        console.error('ERROR ' + file + ': ' + issue);
      }
    } else {
      console.log('OK ' + file);
    }
  }

  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
