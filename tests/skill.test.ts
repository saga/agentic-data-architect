import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { parseSkillManifest, SkillKindSchema } from '../src/skills/catalog.js';

const requiredSections = ['输入校验', '输出', '输出与验证', 'Gate', '期望结果示例'] as const;

test('Skill kind only has capability and workflow', () => {
  assert.equal(SkillKindSchema.safeParse('capability').success, true);
  assert.equal(SkillKindSchema.safeParse('workflow').success, true);
  assert.equal(SkillKindSchema.safeParse('task').success, false);
});

test('解析 capability Skill 元数据', async () => {
  const markdown = await readFile('skills/search-confluence/SKILL.md', 'utf8');
  const manifest = parseSkillManifest(markdown, 'skills/search-confluence/SKILL.md');
  assert.equal(manifest.name, 'search-confluence');
  assert.equal(manifest.metadata.kind, 'capability');
  assert.match(manifest.description, /公司内部 Confluence/);
});

test('当前数据架构是独立 workflow', async () => {
  const markdown = await readFile('skills/current-data-architecture/SKILL.md', 'utf8');
  const manifest = parseSkillManifest(markdown, 'skills/current-data-architecture/SKILL.md');
  assert.equal(manifest.name, 'current-data-architecture');
  assert.equal(manifest.metadata.kind, 'workflow');
  assert.match(manifest.description, /数据来源/);
  assert.match(manifest.description, /数据流/);
});

test('每个 Skill 都有完整的输入、输出、验证、Gate 和期望结果章节', async () => {
  for (const entry of await readdir('skills', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const markdown = await readFile(`skills/${entry.name}/SKILL.md`, 'utf8');
    for (const section of requiredSections) {
      const lines = markdown.split(/\r?\n/);
      const start = lines.findIndex((line) => line.trim() === '## ' + section);
      const end = lines.slice(start + 1).findIndex((line) => line.trim().startsWith('## '));
      const body = lines.slice(start + 1, end < 0 ? undefined : start + 1 + end);
      assert.equal(start >= 0 && body.some((line) => line.trim()), true, entry.name + ' 缺少有效的 ' + section + ' 内容');
    }
  }
});

test('解析 workflow Skill 元数据，包括折叠描述', async () => {
  const markdown = await readFile('skills/legacy-modernization/SKILL.md', 'utf8');
  const manifest = parseSkillManifest(markdown, 'skills/legacy-modernization/SKILL.md');
  assert.equal(manifest.name, 'legacy-modernization');
  assert.equal(manifest.metadata.kind, 'workflow');
  assert.equal(manifest.description.startsWith('数据现代化工作路线'), true);
});

test('missing Skill kind is rejected', () => {
  assert.throws(
    () =>
      parseSkillManifest(
        ['---', 'name: demo', 'description: Demo', '---', '# Demo'].join('\n'),
        'demo/SKILL.md',
      ),
    /metadata/,
  );
});
