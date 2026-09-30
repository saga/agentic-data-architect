import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-'));
process.env.DATA_DIR = dataDir;

const { ensureWorkspace, contextFile, researchDir, appendContextInput, loadWorkspaceContext, redactSensitiveUri } =
  await import('../src/investigation/workspace.js');

test('workspace creates context and research folders', async () => {
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

test('workspace appends inputs without overwriting earlier research context', async () => {
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
  assert.equal(context.userPrompt, 'Modernize proxy voting');
  assert.equal(context.inputs.length, 2);
  assert.equal(context.inputs[1]?.artifactPath, 'research/github/001-search.md');
});

test('redactSensitiveUri never persists database credentials', () => {
  const redacted = redactSensitiveUri('snowflake://user:secret@example.acct/DB/SCHEMA?warehouse=WH&role=ROLE&token=abc');
  assert.equal(redacted.includes('secret'), false);
  assert.equal(redacted.includes('abc'), false);
  assert.ok(redacted.includes('REDACTED'));
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
