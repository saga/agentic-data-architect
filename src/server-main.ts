/**
 * Web server entrypoint。
 *
 * src/server.ts 负责全部业务 API；本入口只负责 Vite middleware、
 * HTTP server 生命周期和进程退出清理。
 */
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');

async function main(): Promise<void> {
  // 必须先安装 Permission bridge，再动态加载 server/copilot 依赖；否则静态 import
  // 会先初始化 CopilotClient，bridge 就无法接管默认 permission handler。
  await import('./agent/copilot-permission-bridge.js');
  const { createApp } = await import('./server.js');
  const { closeConversationStore, recoverRunningConversationTurns } = await import('./investigation/conversation.js');
  const { closeLocalAnalytics } = await import('./analytics/local-data.js');
  const { stopClient } = await import('./agent/copilot.js');

  const dev = config.nodeEnv !== 'production';
  let vite: ViteDevServer | undefined;

  if (dev) {
    vite = await createViteServer({
      root: webRoot,
      server: { middlewareMode: true },
      appType: 'spa',
    });
  }

  // 持久化数据库里的 running 只代表“上一次进程曾经开始过”，不能代表新进程仍有
  // 一个真实的 active turn。Copilot session 目前没有在这里做自动 resume，因此启动时
  // 必须把遗留 running turn 收敛为 aborted，前端才能正确显示“已中断”而不是“仍在执行”。
  const interruptedTurns = recoverRunningConversationTurns();
  if (interruptedTurns > 0) {
    console.warn('Marked ' + interruptedTurns + ' stale investigation turn(s) as interrupted after server restart.');
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
