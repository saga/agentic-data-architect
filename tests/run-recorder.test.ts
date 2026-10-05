import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-run-recorder-'));
process.env.WORKSPACE_DIR = workspaceDir;

const { ensureWorkspace } = await import('../src/investigation/workspace.js');
const { createRunRecorder } = await import('../src/investigation/run-recorder.js');

test('run recorder finalizes manifest with status and duration', async () => {
  await ensureWorkspace('run-recorder-demo');
  const recorder = await createRunRecorder('run-recorder-demo', {
    turnId: 'turn-1',
    model: 'auto',
  });

  await recorder.write('test_event', { ok: true });
  await recorder.close({ status: 'failed', error: 'test failure' });
  await recorder.close({ status: 'completed' });

  const runDir = path.join(workspaceDir, 'run-recorder-demo', 'runs', recorder.runId);
  const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;

  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.error, 'test failure');
  assert.equal(typeof manifest.startedAt, 'string');
  assert.equal(typeof manifest.completedAt, 'string');
  assert.equal(typeof manifest.durationMs, 'number');
});

test.after(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
