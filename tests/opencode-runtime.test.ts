import assert from 'node:assert/strict';
import test from 'node:test';

const { parseOpenCodeModel } = await import('../src/agent/opencode.js');

// 保留这一条：它是 parseOpenCodeModel 唯一的回归守卫。
// 同名的 OpenCode model discovery / Graphify MCP 注册断言属于纯配置值比对，已删除。
test('OpenCode model references use provider/model form', () => {
  assert.equal(parseOpenCodeModel('opencode:ollama/qwen3-coder').providerId, 'ollama');
  assert.deepEqual(parseOpenCodeModel('opencode:ollama/qwen3-coder'), {
    providerId: 'ollama',
    modelId: 'qwen3-coder',
  });
});
