import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-server-'));
process.env.WORKSPACE_DIR = workspaceDir;

const { createApp } = await import('../src/server.js');

const server = http.createServer(createApp());
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
const baseUrl = 'http://127.0.0.1:' + address.port;

test('Mission Gate preserves the user message it blocks', async () => {
  const sessionName = 'mission-message-' + Date.now();

  const createResponse = await fetch(baseUrl + '/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: sessionName,
      userPrompt: '理解旧系统当前的数据架构，为迁移决策提供依据。',
    }),
  });
  assert.equal(createResponse.status, 201);

  const turnId = 'turn-' + Date.now();
  const messageResponse = await fetch(baseUrl + '/api/sessions/' + encodeURIComponent(sessionName) + '/messages/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: '开始',
      turnId,
    }),
  });
  assert.equal(messageResponse.status, 409);

  const body = await messageResponse.json() as { code?: string; turnId?: string };
  assert.equal(body.code, 'MISSION_REQUIRED');
  assert.equal(body.turnId, turnId);

  const sessionResponse = await fetch(baseUrl + '/api/sessions/' + encodeURIComponent(sessionName));
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0]?.role, 'user');
  assert.equal(session.messages[0]?.content, '开始');
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
