import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  GRAPHIFY_MCP_NAME,
  buildGraphifyMcpServer,
  graphifyGraphPath,
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
    '--graph',
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
