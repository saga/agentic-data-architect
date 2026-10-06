import assert from 'node:assert/strict';
import test from 'node:test';

const { isOpenCodeModel, parseOpenCodeModel, listOpenCodeModels } = await import('../src/agent/opencode.js');

test('OpenCode model references use provider/model form', () => {
  assert.equal(isOpenCodeModel('opencode:ollama/qwen3-coder'), true);
  assert.deepEqual(parseOpenCodeModel('opencode:ollama/qwen3-coder'), {
    providerId: 'ollama',
    modelId: 'qwen3-coder',
  });
});

test('OpenCode model discovery maps provider catalog to selectable model IDs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    all: [
      {
        id: 'ollama',
        name: 'Ollama',
        models: {
          'qwen3-coder': { id: 'qwen3-coder', name: 'Qwen3 Coder' },
          'llama': { id: 'llama', name: 'Llama' },
        },
      },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    // 白名单显式传空：不断言本机 .env，测试只验证 catalog 映射逻辑。
    const models = await listOpenCodeModels([]);
    assert.deepEqual(models.map((model) => model.id), [
      'opencode:ollama/llama',
      'opencode:ollama/qwen3-coder',
    ]);
    assert.match(models[1]?.name ?? '', /OpenCode/);

    const filtered = await listOpenCodeModels(['qwen3-coder']);
    assert.deepEqual(filtered.map((model) => model.id), ['opencode:ollama/qwen3-coder']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
