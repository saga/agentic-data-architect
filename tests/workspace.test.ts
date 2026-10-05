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
  setCopilotSessionId,
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

test('first interactive user message becomes the session userPrompt', async () => {
  await ensureWorkspace('first-prompt');
  await appendContextInput('first-prompt', {
    kind: 'user_message',
    title: 'Goal',
    content: 'Analyze portfolio position lineage',
  });
  const context = await loadWorkspaceContext('first-prompt');
  assert.equal(context.userPrompt, 'Analyze portfolio position lineage');
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

test('workspace keeps the confirmed Mission Contract after reload', async () => {
  await ensureWorkspace('mission-persistence');
  const context = await loadWorkspaceContext('mission-persistence');
  context.mission = {
    version: 1,
    purpose: '理解旧系统，为迁移决策提供依据。',
    expectedResult: '形成当前 Data Source、Data Flow 和 Data Model 的说明。',
    deliverables: [
      { id: 'data-source', title: 'Data Source', description: '说明关键数据来源。', required: true },
      { id: 'data-flow', title: 'Data Flow', description: '说明关键数据流向。', required: true },
      { id: 'data-model', title: 'Data Model', description: '说明核心数据模型。', required: true },
    ],
    status: 'confirmed',
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user',
  };
  await fs.writeFile(contextFile('mission-persistence'), JSON.stringify(context, null, 2), 'utf8');

  const reloaded = await loadWorkspaceContext('mission-persistence');
  assert.equal(reloaded.mission?.purpose, context.mission.purpose);
  assert.equal(reloaded.mission?.expectedResult, context.mission.expectedResult);
  assert.deepEqual(reloaded.mission?.deliverables.map((item) => item.id), [
    'data-source',
    'data-flow',
    'data-model',
  ]);
});

test('workspace persists Copilot session with configuration version', async () => {
  await ensureWorkspace('copilot-session-demo');
  await setCopilotSessionId('copilot-session-demo', 'session-123', 7);
  const context = await loadWorkspaceContext('copilot-session-demo');
  assert.equal(context.copilotSessionId, 'session-123');
  assert.equal(context.copilotConfigurationVersion, 7);
});
