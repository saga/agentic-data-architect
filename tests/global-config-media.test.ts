import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('global/task configuration and cache boundaries are explicit', async () => {
  const control = await fs.readFile(new URL('../src/investigation/control.ts', import.meta.url), 'utf8');
  const workspace = await fs.readFile(new URL('../src/investigation/workspace.ts', import.meta.url), 'utf8');
  const config = await fs.readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const page = await fs.readFile(new URL('../web/src/components/InvestigationConfigPage.tsx', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.match(control, /globalConfigFile\(\).*global-config\.json/);
  assert.match(control, /TaskAgentOverrideSchema|extractTaskAgentOverrides/);
  assert.match(workspace, /sessionCacheDir\(name: string\)/);
  assert.match(workspace, /fs\.mkdir\(sessionCacheDir\(name\)/);
  assert.match(config, /dataDir: path\.resolve\(envConfig\.DATA_DIR\)/);
  assert.match(page, /工作台默认（Global）/);
  assert.match(page, /本次 Investigation（Task）/);
  assert.match(server, /GET.*api\/config\/global|api\/config\/global/);
  assert.match(server, /PUT.*api\/config\/global|api\/config\/global/);
  assert.match(page, /Global v/);
  assert.match(page, /将当前设置设为 Global 默认/);
  assert.match(page, /Global Cache/);
  assert.match(page, /Task Cache/);
});

test('remote media resolves through yt-dlp and stores cache outside investigation workspace', async () => {
  const media = await fs.readFile(new URL('../src/media/remote-media.ts', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const avatar = await fs.readFile(new URL('../web/src/components/AssistantAvatar.tsx', import.meta.url), 'utf8');

  assert.match(media, /yt-dlp/);
  assert.match(media, /best\[ext=mp4\]\/best/);
  assert.match(media, /config\.dataDir, 'cache', 'media'/);
  assert.match(media, /getCachedRemoteMedia/);
  assert.match(media, /isSupportedSocialMediaPage\(normalizedSource\)/);
  assert.match(media, /\/video\//i);
  assert.match(server, /\/api\/global\/media\/resolve/);
  assert.match(server, /\/api\/global\/media\/:cacheKey/);
  assert.match(server, /Accept-Ranges/);
  assert.match(avatar, /\/api\/global\/media\/resolve/);
  assert.match(avatar, /setUsingCache/);
  assert.match(avatar, /cacheUrl/);
});
