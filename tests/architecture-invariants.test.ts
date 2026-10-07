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
