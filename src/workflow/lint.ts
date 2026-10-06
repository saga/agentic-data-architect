/**
 * Skill / Markdown Workflow 静态检查。
 *
 * 所有 Skill 都必须声明 metadata.kind。
 * capability 不允许定义自己的 @flow；workflow 必须有 @flow，并继续接受 Journey route 校验。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseSkillManifest } from '../skills/catalog.js';
import { parseJourneyMarkdown } from './journey.js';

const explicitFiles = process.argv.slice(2);

async function skillFiles(): Promise<string[]> {
  if (explicitFiles.length) return explicitFiles;

  const entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push(path.join(config.skillsDir, entry.name, 'SKILL.md'));
  }
  return files.sort();
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
        console.error('ERROR ' + file + ': name="' + manifest.name + '" 与目录名 "' + directoryName + '" 不一致');
        continue;
      }

      const requiredSections = ['输入校验', '输出', '输出与验证', 'Gate', '期望结果示例'];
      for (const section of requiredSections) {
        const heading = new RegExp('^##\\s+' + section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\      const hasFlow = /^##\s+@flow\s+/m.test(markdown);
') + '\\s*
      if (manifest.metadata.kind === 'capability') {
        if (hasFlow) {
          failed = true;
          console.error('ERROR ' + file + ': capability Skill 不能定义 @flow');
        } else {
          console.log('OK ' + file + ' [capability]');
        }
        continue;
      }

      if (!hasFlow) {
        failed = true;
        console.error('ERROR ' + file + ': workflow Skill 必须定义 @flow');
        continue;
      }

      const result = parseJourneyMarkdown(markdown);
      if (result.issues.length) {
        failed = true;
        for (const issue of result.issues) {
          console.error('ERROR ' + file + ': ' + issue);
        }
      } else {
        console.log('OK ' + file + ' [workflow]');
      }
    } catch (error) {
      failed = true;
      console.error(
        'ERROR ' + file + ': ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
, 'm');
        if (!heading.test(markdown)) {
          failed = true;
          console.error('ERROR ' + file + ': 缺少 Skill Contract 章节：## ' + section);
        }
      }

      const hasFlow = /^##\s+@flow\s+/m.test(markdown);

      if (manifest.metadata.kind === 'capability') {
        if (hasFlow) {
          failed = true;
          console.error('ERROR ' + file + ': capability Skill 不能定义 @flow');
        } else {
          console.log('OK ' + file + ' [capability]');
        }
        continue;
      }

      if (!hasFlow) {
        failed = true;
        console.error('ERROR ' + file + ': workflow Skill 必须定义 @flow');
        continue;
      }

      const result = parseJourneyMarkdown(markdown);
      if (result.issues.length) {
        failed = true;
        for (const issue of result.issues) {
          console.error('ERROR ' + file + ': ' + issue);
        }
      } else {
        console.log('OK ' + file + ' [workflow]');
      }
    } catch (error) {
      failed = true;
      console.error(
        'ERROR ' + file + ': ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
