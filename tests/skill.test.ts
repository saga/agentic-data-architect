import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseSkillManifest, syncRuntimeSkillWorkspace } from '../src/skills/catalog.js';

const requiredSections = ['输入校验', '输出', '输出与验证', 'Gate', '期望结果示例'] as const;

test('每个 Skill 都有完整的输入、输出、验证、Gate 和期望结果章节', async () => {
  for (const entry of await readdir('skills', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const markdown = await readFile(`skills/${entry.name}/SKILL.md`, 'utf8');
    const manifest = parseSkillManifest(markdown, `skills/${entry.name}/SKILL.md`);
    assert.equal(manifest.name, entry.name, entry.name + ' 的 Skill manifest 名称必须与目录名一致');
    for (const section of requiredSections) {
      const lines = markdown.split(/\r?\n/);
      const start = lines.findIndex((line) => line.trim() === '## ' + section);
      const end = lines.slice(start + 1).findIndex((line) => line.trim().startsWith('## '));
      const body = lines.slice(start + 1, end < 0 ? undefined : start + 1 + end);
      assert.equal(start >= 0 && body.some((line) => line.trim()), true, entry.name + ' 缺少有效的 ' + section + ' 内容');
    }
  }
});

test('non-copilot Skill bridge exposes capability Skills and only the selected Workflow', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentic-data-architect-skills-'));
  try {
    const root = await syncRuntimeSkillWorkspace(workspace, 'current-data-architecture');
    const entries = await readdir(root, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));

    assert.equal(names.has('search-confluence'), true);
    assert.equal(names.has('current-data-architecture'), true);
    assert.equal(names.has('legacy-modernization'), false);
    assert.equal(names.has('data-architecture-assessment'), false);
    assert.equal((await lstat(path.join(root, 'current-data-architecture'))).isSymbolicLink(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
