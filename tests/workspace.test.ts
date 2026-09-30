import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-'));
process.env.WORKSPACE_DIR = workspaceDir;

const {
  ensureWorkspace,
  contextFile,
  sharedIndexFile,
  appendContextInput,
  loadWorkspaceContext,
  redactSensitiveUri,
  addSharedDocument,
} = await import('../src/investigation/workspace.js');

test('workspace creates a minimal session root and shared index', async () => {
  const root = await ensureWorkspace('demo', {
    userPrompt: 'Modernize proxy voting',
    goal: 'Replace legacy workflow',
    scope: ['Proxy Voting'],
    systems: ['ISS'],
  });
  const context = JSON.parse(await fs.readFile(contextFile('demo'), 'utf8'));
  assert.equal(root, path.join(workspaceDir, 'demo'));
  assert.equal(context.userPrompt, 'Modernize proxy voting');
  assert.equal(context.inputs.length, 1);
  assert.equal(await exists(path.join(workspaceDir, 'demo', 'transcript.md')), true);
  assert.equal(await exists(path.join(workspaceDir, 'shared', 'index.json')), true);
});

test('workspace appends inputs without overwriting earlier context', async () => {
  await ensureWorkspace('demo', { userPrompt: 'Initial prompt' });
  await appendContextInput('demo', {
    kind: 'research',
    title: 'GitHub search',
    source: 'github',
    uri: 'https://github.com/example/repo',
    artifactPath: 'shared/github/001-search.md',
    content: 'Search query and important findings',
    important: true,
  });
  const context = await loadWorkspaceContext('demo');
  assert.equal(context.userPrompt, 'Modernize proxy voting');
  assert.equal(context.inputs.length, 2);
  assert.equal(context.inputs[1]?.artifactPath, 'shared/github/001-search.md');
});

test('shared index records reusable documents', async () => {
  await addSharedDocument(
    'confluence',
    'page-123',
    'Position model',
    '# Position\n\nCurrent model.',
    { uri: 'https://example.atlassian.net/wiki/page-123', source: 'confluence', sessionNames: ['demo'] },
  );
  const index = JSON.parse(await fs.readFile(sharedIndexFile(), 'utf8')) as {
    artifacts: Array<{ id: string; path: string }>;
  };
  assert.equal(index.artifacts[0]?.id, 'page-123');
  assert.equal(index.artifacts[0]?.path, 'shared/confluence/page-123.md');
  assert.equal(await exists(path.join(workspaceDir, 'shared', 'confluence', 'page-123.md')), true);
});

test('redactSensitiveUri never persists database credentials', () => {
  const redacted = redactSensitiveUri(
    'snowflake://user:secret@example.acct/DB/SCHEMA?warehouse=WH&role=ROLE&token=abc',
  );
  assert.equal(redacted.includes('secret'), false);
  assert.equal(redacted.includes('abc'), false);
  assert.ok(redacted.includes('REDACTED'));
});

test.after(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}