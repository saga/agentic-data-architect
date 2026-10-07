import { strict as assert } from 'node:assert';
import test from 'node:test';
import { AuditDataError, readAuditEvents, toCopilotMcpServers, type InvestigationControl } from '../src/investigation/control.js';

function control(): InvestigationControl {
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: new Date().toISOString(),
    research: {
      githubRepositories: [],
      githubSearchMode: 'only_selected',
      keywords: [],
      importantDocuments: [],
    },
    agent: {
      systemPrompt: { version: 1, content: '' },
      mcpServers: [],
    },
    history: [],
  };
}

test('HTTP MCP headers are preserved and environment references are resolved', () => {
  process.env.TEST_MCP_TOKEN = 'secret-value';

  const current = control();
  current.agent.mcpServers.push({
    name: 'docs',
    version: 1,
    enabled: true,
    type: 'http',
    url: 'https://example.test/mcp?token=${TEST_MCP_TOKEN}',
    tools: ['search'],
    headers: {
      Authorization: 'Bearer ${TEST_MCP_TOKEN}',
    },
  });

  const result = toCopilotMcpServers(current);
  assert.deepEqual(result.docs, {
    type: 'http',
    url: 'https://example.test/mcp?token=secret-value',
    tools: ['search'],
    headers: {
      Authorization: 'Bearer secret-value',
    },
  });
});

test('malformed audit records are surfaced instead of treated as missing', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const config = await import('../src/config.js');
  const workspace = path.join(config.config.workspaceDir, 'control-audit-test');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'audit.jsonl'),
    JSON.stringify({
      id: 'audit-1',
      timestamp: new Date().toISOString(),
      actor: 'system',
      action: 'test',
      summary: 'valid',
    }) + '\n' + '{this is not valid json}\n',
    'utf8',
  );
  await assert.rejects(
    () => readAuditEvents('control-audit-test', 10),
    (error: unknown) => error instanceof AuditDataError,
  );
});

