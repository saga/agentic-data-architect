import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  GRAPHIFY_MCP_NAME,
  buildGraphifyMcpServer,
  getGraphifyRuntimeMetadata,
  graphifyGraphPath,
  prepareGraphifyEnvironment,
  requireGraphifyMcpCommand,
  ensureGraphifyGraph,
  isGraphifyTool,
} from '../src/adapters/graphify.js';

test('Graphify graph path is scoped to the current working directory', () => {
  const root = '/tmp/agentic-data-architect/session-1';
  assert.equal(
    graphifyGraphPath(root),
    path.join(root, 'graphify-out', 'graph.json'),
  );
});

test('Graphify MCP server exposes only structural read tools', () => {
  const result = buildGraphifyMcpServer('/tmp/session', '/opt/graphify-mcp');
  assert.equal(result?.name, GRAPHIFY_MCP_NAME);
  assert.equal(result?.server.command, '/opt/graphify-mcp');
  assert.deepEqual(result?.server.args, [
    '/tmp/session/graphify-out/graph.json',
  ]);
  assert.deepEqual(result?.server.tools, [
    'query_graph',
    'get_node',
    'get_neighbors',
    'get_community',
    'god_nodes',
    'graph_stats',
    'shortest_path',
  ]);
});




test('real Graphify runtime builds a structural graph for an Investigation directory', async () => {
  prepareGraphifyEnvironment();
  requireGraphifyMcpCommand();

  const root = await mkdtemp(path.join(tmpdir(), 'agentic-graphify-'));
  try {
    await writeFile(
      path.join(root, 'sample.sql'),
      'create table positions as select security_id from raw_positions;\\n',
    );
    await writeFile(
      path.join(root, 'worker.py'),
      'def load_positions():\\n    return "positions"\\n',
    );

    const metadata = await ensureGraphifyGraph(root, true);
    assert.equal(metadata.status, 'available');
    assert.equal(metadata.enabled, true);
    assert.equal(metadata.graphPath, graphifyGraphPath(root));
    assert.match(metadata.graphHash ?? '', /^[a-f0-9]{64}$/);

    const graph = await readFile(graphifyGraphPath(root), 'utf8');
    assert.ok(graph.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
