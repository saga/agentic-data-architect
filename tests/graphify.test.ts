import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  GRAPHIFY_MCP_NAME,
  buildGraphifyMcpServer,
  getGraphifyRuntimeMetadata,
  graphifyGraphPath,
  prepareGraphifyEnvironment,
  requireGraphifyMcpCommand,
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

test('real Graphify runtime is installed and can build a graph', async () => {
  prepareGraphifyEnvironment();
  const mcpCommand = requireGraphifyMcpCommand();
  execFileSync(mcpCommand, ['--help'], { stdio: 'ignore' });

  const root = await mkdtemp(path.join(tmpdir(), 'agentic-graphify-'));
  try {
    await writeFile(path.join(root, 'sample.sql'), 'create table positions as select security_id from raw_positions;\n');
    await writeFile(path.join(root, 'worker.py'), 'def load_positions():\n    return "positions"\n');

    execFileSync('graphify', ['extract', root, '--code-only', '--no-viz'], {
      stdio: 'ignore',
      timeout: 60_000,
      env: process.env,
    });

    const graphPath = graphifyGraphPath(root);
    const graph = await readFile(graphPath, 'utf8');
    assert.ok(graph.length > 0);

    const metadata = await getGraphifyRuntimeMetadata(root);
    assert.equal(metadata.status, 'available');
    assert.equal(metadata.enabled, true);
    assert.equal(metadata.graphPath, graphPath);
    assert.match(metadata.graphHash ?? '', /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
