import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseSkillManifest, SkillKindSchema } from '../src/skills/catalog.js';

test('Skill kind only has capability and workflow', () => {
  assert.equal(SkillKindSchema.safeParse('capability').success, true);
  assert.equal(SkillKindSchema.safeParse('workflow').success, true);
  assert.equal(SkillKindSchema.safeParse('task').success, false);
});

test('parses capability Skill metadata', async () => {
  const markdown = await readFile('skills/search-confluence/SKILL.md', 'utf8');
  const manifest = parseSkillManifest(markdown, 'skills/search-confluence/SKILL.md');
  assert.equal(manifest.name, 'search-confluence');
  assert.equal(manifest.metadata.kind, 'capability');
  assert.match(manifest.description, /Confluence/);
});

test('parses workflow Skill metadata including folded description', async () => {
  const markdown = await readFile('skills/legacy-modernization/SKILL.md', 'utf8');
  const manifest = parseSkillManifest(markdown, 'skills/legacy-modernization/SKILL.md');
  assert.equal(manifest.name, 'legacy-modernization');
  assert.equal(manifest.metadata.kind, 'workflow');
  assert.equal(manifest.description.startsWith('Data Modernization Journey'), true);
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
