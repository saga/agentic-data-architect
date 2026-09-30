import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

async function withTempDataDir(fn: () => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('workspace creates context and research folders', async () => {
  await withTempDataDir(async () => {
    const { ensureWorkspace, contextFile, researchDir } = await import('../src/investigation/workspace.js');
    const root = await ensureWorkspace('demo', {
      userPrompt: 'Modernize proxy voting',
      goal: 'Replace legacy workflow',
      scope: ['Proxy Voting'],
      systems: ['ISS'],
    });
    const context = JSON.parse(await fs.readFile(contextFile('demo'), 'utf8'));
    assert.equal(root.endsWith(path.join('demo', 'workspace')), true);
    assert.equal(context.userPrompt, 'Modernize proxy voting');
    assert.equal(context.inputs.length, 1);
    assert.equal(await exists(path.join(researchDir('demo'), 'github')), true);
    assert.equal(await exists(path.join(researchDir('demo'), 'leanix')), true);
    assert.equal(await exists(path.join(researchDir('demo'), 'confluence')), true);
  });
});

test('workspace appends inputs without overwriting earlier research context', async () => {
  await withTempDataDir(async () => {
    const { ensureWorkspace, appendContextInput, loadWorkspaceContext } =
      await import('../src/investigation/workspace.js');
    await ensureWorkspace('demo', { userPrompt: 'Initial prompt' });
    await appendContextInput('demo', {
      kind: 'research',
      title: 'GitHub search',
      source: 'github',
      uri: 'https://github.com/example/repo',
      artifactPath: 'research/github/001-search.md',
      content: 'Search query and important findings',
      important: true,
    });
    const context = await loadWorkspaceContext('demo');
    assert.equal(context.userPrompt, 'Initial prompt');
    assert.equal(context.inputs.length, 2);
    assert.equal(context.inputs[1]?.artifactPath, 'research/github/001-search.md');
  });
});

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
