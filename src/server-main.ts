/**
 * Web server entrypoint。
 *
 * src/server.ts 负责全部业务 API；本入口只负责 Vite middleware、
 * HTTP server 生命周期和进程退出清理。
 */
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { config } from './config.js';
import { createApp } from './server.js';
import { closeConversationStore, recoverRunningConversationTurns } from './investigation/conversation.js';
import { closeLocalAnalytics } from './analytics/local-data.js';
import { stopClient } from './agent/copilot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');

async function main(): Promise<void> {
  const dev = config.nodeEnv !== 'production';
  let vite: ViteDevServer | undefined;

  if (dev) {
    vite = await createViteServer({
      root: webRoot,
      server: { middlewareMode: true },
      appType: 'spa',
    });
  }

  const recoveredTurns = recoverRunningConversationTurns();
  if (recoveredTurns > 0) {
    console.warn('Recovered ' + recoveredTurns + ' interrupted investigation turn(s).');
  }

  const app = createApp(vite);

  const server = createHttpServer(app);
  server.listen(config.port, config.host, () => {
    console.log(
      'Agentic Data Architect Web UI: http://'
      + (config.host === '0.0.0.0' ? 'localhost' : config.host)
      + ':' + config.port,
    );
  });

  const shutdown = async () => {
    server.close();
    await vite?.close();
    closeLocalAnalytics();
    closeConversationStore();
    await stopClient();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
