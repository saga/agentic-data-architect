import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseSkillManifest, SkillKindSchema } from '../src/skills/catalog.js';

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

test('现状架构分析是 capability 而不是 workflow', async () => {
  const markdown = await readFile('skills/current-state-architecture/SKILL.md', 'utf8');
  const manifest = parseSkillManifest(markdown, 'skills/current-state-architecture/SKILL.md');
  assert.equal(manifest.name, 'current-state-architecture');
  assert.equal(manifest.metadata.kind, 'capability');
  assert.match(manifest.description, /Data Source/);
  assert.match(manifest.description, /Data Flow/);
  assert.match(manifest.description, /Data Model/);
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
