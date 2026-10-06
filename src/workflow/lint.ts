import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseSkillManifest } from '../skills/catalog.js';
import { parseJourneyMarkdown } from './journey.js';

const explicitFiles = process.argv.slice(2);
const requiredSections = ['输入校验', '输出', '输出与验证', 'Gate', '期望结果示例'] as const;

function hasSectionContent(markdown: string, title: string): boolean {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## ' + title);
  if (start < 0) return false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) return false;
    if (line) return true;
  }
  return false;
}

async function skillFiles(): Promise<string[]> {
  if (explicitFiles.length) return explicitFiles;
  const entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory())
    .map((entry) => path.join(config.skillsDir, entry.name, 'SKILL.md')).sort();
}

let failed = false;
try {
  const files = await skillFiles();
  if (!files.length) {
    console.error('ERROR 没有找到 Skill');
    process.exitCode = 1;
  }
  for (const file of files) {
    const markdown = await fs.readFile(file, 'utf8');
    try {
      const manifest = parseSkillManifest(markdown, file);
      const directoryName = path.basename(path.dirname(file));
      if (manifest.name !== directoryName) {
        failed = true;
        console.error('ERROR ' + file + ': Skill 名称与目录名不一致。');
        continue;
      }
      for (const section of requiredSections) {
        if (!hasSectionContent(markdown, section)) {
          failed = true;
          console.error('ERROR ' + file + ': 缺少 Skill Contract 章节：## ' + section);
        }
      }
      const hasFlow = /^##\s+@flow\s+/m.test(markdown);
      if (manifest.metadata.kind === 'capability') {
        if (hasFlow) {
          failed = true;
          console.error('ERROR ' + file + ': capability Skill 不能定义 @flow。');
        } else {
          console.log('OK ' + file + ' [capability]');
        }
        continue;
      }
      if (!hasFlow) {
        failed = true;
        console.error('ERROR ' + file + ': workflow Skill 必须定义 @flow。');
        continue;
      }
      const result = parseJourneyMarkdown(markdown);
      if (result.issues.length) {
        failed = true;
        for (const issue of result.issues) console.error('ERROR ' + file + ': ' + issue);
      } else {
        console.log('OK ' + file + ' [workflow]');
      }
    } catch (error) {
      failed = true;
      console.error('ERROR ' + file + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}