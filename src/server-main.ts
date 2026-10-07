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
import { listPendingCopilotPermissions, listPendingCopilotUserInputs } from './agent/copilot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');

async function main(): Promise<void> {
  await import('./agent/copilot-permission-bridge.js');
  const { createApp } = await import('./server.js');
  const { closeConversationStore, recoverRunningConversationTurns } = await import('./investigation/conversation.js');
  const { getActiveInvestigationTurn } = await import('./workflow/ask.js');
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

  const interruptedTurns = recoverRunningConversationTurns();
  if (interruptedTurns > 0) {
    console.warn('Marked ' + interruptedTurns + ' stale investigation turn(s) as interrupted after server restart.');
  }

  const app = createApp(vite);

  // 返回当前 Node.js 进程真正持有的 active turn，而不是 SQLite/trajectory 的历史 running 状态。
  // 页面刷新、Vite HMR 都不会改变这个状态。
  app.get('/api/sessions/:name/execution', (req, res) => {
    const name = path.basename(String(req.params.name));
    const active = getActiveInvestigationTurn(name);
    const pendingPermissions = active ? listPendingCopilotPermissions(name) : [];
    const pendingUserInputs = active ? listPendingCopilotUserInputs(name) : [];
    const state = !active
      ? 'idle'
      : active.phase === 'committing'
        ? 'committing'
        : pendingUserInputs.length > 0
          ? 'waiting_user_input'
          : pendingPermissions.length > 0
            ? 'waiting_permission'
            : 'running';

    res.json({
      state,
      running: Boolean(active),
      turnId: active?.turnId ?? null,
      phase: active?.phase ?? null,
      startedAt: active?.startedAt ?? null,
      lastActivityAt: active?.lastActivityAt ?? null,
      lastActivity: active?.lastActivity ?? null,
      pendingPermissionCount: pendingPermissions.length,
      pendingUserInputCount: pendingUserInputs.length,
    });
  });

  const server = createHttpServer(app);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!config.allowRemoteHost && !localHosts.has(config.host)) {
    throw new Error(
      '个人本机 Agent 默认只能监听本机地址。当前 HOST=' + config.host
      + '；如确实需要远程访问，请显式设置 ALLOW_REMOTE_HOST=true。',
    );
  }

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
