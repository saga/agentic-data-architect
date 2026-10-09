import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-server-'));
process.env.WORKSPACE_DIR = workspaceDir;

// Avoid probing real Agent providers in this HTTP contract test. Session creation
// is not the behavior under test; provider discovery can legitimately wait on local runtimes.
const { ensureWorkspace } = await import('../src/investigation/workspace.js');
const { closeConversationStore, listConversationMessages } = await import('../src/investigation/conversation.js');
const { createApp } = await import('../src/server.js');

const server = http.createServer(createApp());
const sockets = new Set<import('node:net').Socket>();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
const baseUrl = 'http://127.0.0.1:' + address.port;

test('Mission Gate preserves the user message it blocks', async () => {
  const sessionName = 'mission-message-' + Date.now();

  // Seed only the workspace state this route needs. Calling POST /api/sessions here would
  // run getAgentCatalog() and make this isolated gate test depend on real runtime discovery.
  await ensureWorkspace(sessionName, {
    userPrompt: '理解旧系统当前的数据架构，为迁移决策提供依据。',
  });

  const turnId = 'turn-' + Date.now();
  const messageResponse = await fetch(
    baseUrl + '/api/sessions/' + encodeURIComponent(sessionName) + '/messages/stream',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '开始', turnId }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  assert.equal(messageResponse.status, 409);

  const body = await messageResponse.json() as { code?: string; details?: { turnId?: string } };
  assert.equal(body.code, 'MISSION_REQUIRED');
  assert.equal(body.details?.turnId, turnId);

  // Read the durable store directly. Loading the full session view would add unrelated
  // mission-progress/control-summary dependencies to this persistence contract test.
  const messages = listConversationMessages(sessionName);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.content, '开始');
});

test.after(async () => {
  // Teardown must not await server.close(): its callback can remain pending when a client
  // keep-alive socket is left in an unusual state. Closing the listener and actively
  // destroying every known connection is sufficient; only workspace cleanup is awaited.
  server.close();
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  closeConversationStore();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
