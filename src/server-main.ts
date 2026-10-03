/**
 * Workflow-aware server entrypoint。
 *
 * src/server.ts 负责当前业务 API；本入口只保留 /journey 兼容响应和服务启动逻辑。
 */
import express, { type Response } from 'express';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { config } from './config.js';
import { createApp } from './server.js';
import { parseRequest } from './api/schemas.js';
import {
  buildJourneyAgentInstruction,
  getJourneySnapshot,
  resetJourneyCustomization,
} from './workflow/journey-editor.js';
import { loadWorkspaceContext } from './investigation/workspace.js';
import { closeConversationStore, recoverRunningConversationTurns } from './investigation/conversation.js';
import { closeLocalAnalytics } from './analytics/local-data.js';
import { stopClient } from './agent/copilot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');

function sessionKey(name: string): string {
  const safe = path.basename(name);
  if (!name || safe !== name || name === '.' || name === '..') {
    throw new Error('Invalid session name');
  }
  return safe;
}

function sendRouteError(res: Response, error: unknown): void {
  res.status(400).json({
    error: error instanceof Error ? error.message : String(error),
  });
}

function registerJourneyRoutes(app: express.Express): void {
  /** 兼容旧地图 UI 的轻量状态接口。 */
  app.get('/api/sessions/:name/journey', async (req, res) => {
    try {
      const name = sessionKey(String(req.params.name));
      const context = await loadWorkspaceContext(name);
      if (!context.workflow) {
        res.json({ journey: null, routePlan: context.journeyPlan ?? null });
        return;
      }
      const snapshot = await getJourneySnapshot(name, context.workflow);
      res.json({
        journey: snapshot.state,
        routePlan: context.journeyPlan ?? null,
        workflow: {
          source: snapshot.source,
          baseWorkflowId: snapshot.baseWorkflowId,
          version: snapshot.version,
        },
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  /** 兼容旧调试入口：只验证，不落盘。 */
  app.post('/api/sessions/:name/workflow/validate', async (req, res) => {
    try {
      const name = sessionKey(String(req.params.name));
      const context = await loadWorkspaceContext(name);
      if (!context.workflow) {
        res.status(409).json({ error: '当前 Investigation 没有选择 Workflow。' });
        return;
      }
      const body = parseRequest(JourneyEditBodySchema, req.body);
      res.json(validateJourneyEdit(body.definition, body.layout));
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  /** 恢复 Skill 内置路线，并清除 Investigation 级自定义 Workflow。 */
  app.post('/api/sessions/:name/workflow/reset', async (req, res) => {
    try {
      const name = sessionKey(String(req.params.name));
      const context = await loadWorkspaceContext(name);
      if (!context.workflow) {
        res.status(409).json({ error: '当前 Investigation 没有选择 Workflow。' });
        return;
      }
      res.json(await resetJourneyCustomization(name, context.workflow));
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  /** 测试 / 调试入口：查看 Agent 本轮会收到的 Workflow 控制摘要。 */
  app.get('/api/sessions/:name/workflow/instruction', async (req, res) => {
    try {
      const name = sessionKey(String(req.params.name));
      const context = await loadWorkspaceContext(name);
      res.type('text/plain').send(await buildJourneyAgentInstruction(name, context.workflow));
    } catch (error) {
      sendRouteError(res, error);
    }
  });
}

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

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  registerJourneyRoutes(app);
  app.use(createApp(vite));

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
