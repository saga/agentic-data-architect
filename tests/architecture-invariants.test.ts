import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('architecture contract boundaries remain single-track', async () => {
  const api = await fs.readFile(new URL('../web/src/app/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /schemaOrInit|return schema \? schema\.parse\(data\) : data as T/);
  assert.match(api, /schema\.parse\(data\)/);

  const server = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /sharedDir\s*,\s*['"]assistant['"]|sharedAvatarPath|sharedMetaPath/);

  const modernization = await fs.readFile(new URL('../src/model/modernization.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(modernization, /journey:\s*JourneyStateSchema|journey\?:/);

  const assessment = await fs.readFile(new URL('../src/workflow/assessment.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(assessment, /journey:\s*z\.unknown\(\)/);
});

test('remote binding has an explicit opt-in guard', async () => {
  const config = await fs.readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const serverMain = await fs.readFile(new URL('../src/server-main.ts', import.meta.url), 'utf8');
  assert.match(config, /ALLOW_REMOTE_HOST/);
  assert.match(serverMain, /ALLOW_REMOTE_HOST=true/);
});

test('global media cache has a bounded total lifecycle', async () => {
  const media = await fs.readFile(new URL('../src/media/remote-media.ts', import.meta.url), 'utf8');
  assert.match(media, /MAX_CACHE_TOTAL_BYTES = 512 \* 1024 \* 1024/);
  assert.match(media, /enforceCacheBudget/);
});

test('Agent runtime data stays outside Investigation workspace', async () => {
  const copilot = await fs.readFile(new URL('../src/agent/copilot.ts', import.meta.url), 'utf8');
  assert.match(copilot, /path\.join\(config\.dataDir, 'copilot'\)/);
  assert.doesNotMatch(copilot, /path\.join\(config\.workspaceDir, 'copilot'\)/);
});

test('CLI does not force a legacy workflow by default', async () => {
  const cli = await fs.readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /let workflow: WorkflowId \| null = null/);
  assert.match(cli, /current-data-architecture/);
  assert.match(cli, /data-architecture-assessment/);
});

test('CodeBuddy query turn limit is configured rather than hardcoded', async () => {
  const config = await fs.readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const codebuddy = await fs.readFile(new URL('../src/agent/codebuddy.ts', import.meta.url), 'utf8');
  assert.match(config, /CODEBUDDY_MAX_TURNS/);
  assert.match(config, /codeBuddyMaxTurns/);
  assert.match(codebuddy, /maxTurns: config\.codeBuddyMaxTurns/);
  assert.doesNotMatch(codebuddy, /maxTurns:\s*20\b/);
});

test('Graphify fallback explains that source tools will continue the investigation', async () => {
  const codebuddy = await fs.readFile(new URL('../src/agent/codebuddy.ts', import.meta.url), 'utf8');
  assert.match(codebuddy, /结构分析工具这次没有生成可用结果/);
  assert.match(codebuddy, /改用源码工具继续调查/);
});


test('user-facing runtime errors do not expose common internal control terms', async () => {
  const files = [
    '../src/server.ts',
    '../src/agent/codebuddy.ts',
    '../src/agent/copilot.ts',
    '../src/agent/opencode.ts',
    '../src/workflow/ask.ts',
    '../src/workflow/journey-editor.ts',
    '../src/workflow/journey-ai.ts',
  ];
  const ai = String.fromCharCode(65, 73);
  const ag = String.fromCharCode(65, 103, 101, 110, 116);
  const se = String.fromCharCode(83, 101, 115, 115, 105, 111, 110);
  const wf = String.fromCharCode(87, 111, 114, 107, 102, 108, 111, 119);
  const patterns = [
    ai + ' 没有返回',
    ai + ' 使用的工作地图',
    ag + ' 执行失败',
    se + ' 错误',
    wf + ' Gate 未通过',
  ];
  for (const file of files) {
    const content = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    for (const pattern of patterns) assert.doesNotMatch(content, new RegExp(pattern));
  }
});