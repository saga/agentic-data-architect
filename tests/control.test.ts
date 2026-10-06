import { strict as assert } from 'node:assert';
import test from 'node:test';
import { toCopilotMcpServers, type InvestigationControl } from '../src/investigation/control.js';

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

test('disabled MCP servers are not exposed to Copilot', () => {
  const current = control();
  current.agent.mcpServers.push({
    name: 'disabled',
    version: 1,
    enabled: false,
    type: 'http',
    url: 'https://example.test/mcp',
  });

  assert.deepEqual(toCopilotMcpServers(current), {});
});


test('Investigation control schema rejects invalid MCP settings', async () => {
  const { InvestigationControlSchema } = await import('../src/investigation/schemas.js');
  const current = control();
  const result = InvestigationControlSchema.safeParse({
    ...current,
    agent: {
      ...current.agent,
      mcpServers: [{ name: 'broken', version: 1, enabled: true, type: 'unknown' }],
    },
  });
  assert.equal(result.success, false);
});

