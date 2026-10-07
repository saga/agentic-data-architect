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
  loadWorkspaceContext,
  redactSensitiveUri,
} = await import('../src/investigation/workspace.js');
const {
  loadInvestigation,
  saveInvestigation,
  newInvestigation,
} = await import('../src/investigation/store.js');

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


test('concurrent investigation saves merge facts instead of losing the other snapshot', async () => {
  const name = 'concurrent-save';
  await newInvestigation(name, {
    userPrompt: '并发保存测试',
    goal: '验证并发保存不会覆盖另一份调查结果',
  });

  const first = await loadInvestigation(name);
  const second = await loadInvestigation(name);
  const makeEvidence = (id: string, source: string) => ({
    id,
    type: 'documentation' as const,
    investigationId: name,
    discoveryRunId: 'run-1',
    source,
    collectedAt: '2026-10-08T00:00:00.000Z',
  });

  first.evidence.push(makeEvidence('ev-1', 'source-1'));
  second.evidence.push(makeEvidence('ev-2', 'source-2'));

  await Promise.all([
    saveInvestigation(first),
    saveInvestigation(second),
  ]);

  const merged = await loadInvestigation(name);
  assert.deepEqual(
    merged.evidence.map((item) => item.id).sort(),
    ['ev-1', 'ev-2'],
  );
});
