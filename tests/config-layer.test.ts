import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-config-'));
process.env.WORKSPACE_DIR = path.join(root, 'workspace');
process.env.DATA_DIR = path.join(root, 'data');

const {
  loadInvestigationControl,
  updateInvestigationControl,
  updateGlobalConfiguration,
} = await import('../src/investigation/control.js');

const taskAgent = (control: Awaited<ReturnType<typeof loadInvestigationControl>>) => ({ ...control.agent });

test('task configuration inherits Global and stores only explicit overrides', async () => {
  const first = await loadInvestigationControl('task-a');
  const second = await loadInvestigationControl('task-b');

  assert.equal(first.agent.model, second.agent.model);

  await updateInvestigationControl('task-a', {
    research: first.research,
    agent: { ...taskAgent(first), personality: 'Task A personality' },
  }, 'task override');

  const a = await loadInvestigationControl('task-a');
  const b = await loadInvestigationControl('task-b');
  assert.equal(a.agent.personality, 'Task A personality');
  assert.notEqual(b.agent.personality, 'Task A personality');

  const stored = JSON.parse(await fs.readFile(path.join(process.env.WORKSPACE_DIR!, 'task-a', 'control.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.agent.personality, 'Task A personality');
  assert.equal('model' in stored.agent, false);
});

test('Global changes flow into inheriting tasks but never overwrite task overrides', async () => {
  const before = await loadInvestigationControl('task-a');
  const globalModel = before.agent.model === 'auto' ? 'gpt-5' : 'auto';

  await updateGlobalConfiguration({ model: globalModel });

  const a = await loadInvestigationControl('task-a');
  const b = await loadInvestigationControl('task-b');
  assert.equal(a.agent.model, globalModel);
  assert.equal(b.agent.model, globalModel);
  assert.equal(a.agent.personality, 'Task A personality');

  await updateInvestigationControl('task-a', {
    research: a.research,
    agent: { ...a.agent, model: 'task-specific-model' },
  }, 'task model override');

  await updateGlobalConfiguration({ model: 'new-global-model' });

  const a2 = await loadInvestigationControl('task-a');
  const b2 = await loadInvestigationControl('task-b');
  assert.equal(a2.agent.model, 'task-specific-model');
  assert.equal(b2.agent.model, 'new-global-model');
});

test('editing a Task after Global changes does not materialize inherited values as overrides', async () => {
  const b = await loadInvestigationControl('task-b');
  const storedBefore = JSON.parse(await fs.readFile(path.join(process.env.WORKSPACE_DIR!, 'task-b', 'control.json'), 'utf8'));
  assert.equal('model' in storedBefore.agent, false);

  await updateGlobalConfiguration({ model: 'global-after-change' });
  const inherited = await loadInvestigationControl('task-b');
  assert.equal(inherited.agent.model, 'global-after-change');

  await updateInvestigationControl('task-b', {
    research: inherited.research,
    agent: { ...inherited.agent, personality: 'edited after global change' },
  }, 'edit after global change');

  const storedAfter = JSON.parse(await fs.readFile(path.join(process.env.WORKSPACE_DIR!, 'task-b', 'control.json'), 'utf8'));
  assert.equal(storedAfter.agent.personality, 'edited after global change');
  assert.equal('model' in storedAfter.agent, false);
});

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
