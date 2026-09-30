import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { answerQuestion } from './workflow/ask.js';
import { buildReport } from './analysis/report.js';
import { config } from './config.js';
import {
  ensureWorkspace,
  loadWorkspaceContext,
  workspaceRoot,
  type WorkspaceContext,
} from './investigation/workspace.js';
import { investigationExists, newInvestigation, saveInvestigation } from './investigation/store.js';
import { stopClient } from './agent/copilot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');
const webDist = path.join(webRoot, 'dist');

interface SessionSummary {
  key: string;
  label: string;
  userPrompt: string;
  updatedAt: string;
}

function sessionKey(name: string): string {
  const safe = path.basename(name);
  if (!name || safe !== name || name === '.' || name === '..') {
    throw new Error('Invalid session name');
  }
  return safe;
}

function messagesFromContext(context: WorkspaceContext) {
  return context.inputs
    .filter((input) => input.kind === 'question' || input.kind === 'assistant_message')
    .map((input) => ({
      id: input.id,
      role: input.kind === 'question' ? 'user' : 'assistant',
      content: input.content ?? '',
      capturedAt: input.capturedAt,
    }));
}

async function listSessions(): Promise<SessionSummary[]> {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  const entries = await fs.readdir(config.workspaceDir, { withFileTypes: true });
  const result: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'shared') continue;
    try {
      const context = await loadWorkspaceContext(entry.name);
      result.push({
        key: entry.name,
        label: context.userPrompt?.trim().slice(0, 60) || entry.name,
        userPrompt: context.userPrompt ?? '',
        updatedAt: context.updatedAt,
      });
    } catch {
      // Ignore malformed/non-session directories in the UI list.
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function createSession(name?: string, userPrompt?: string) {
  const key = sessionKey(
    name?.trim() ||
      'session-' +
        new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
  );
  if (await investigationExists(key)) {
    return loadWorkspaceContext(key);
  }
  const investigation = newInvestigation(key, userPrompt?.trim() ?? '');
  await saveInvestigation(investigation);
  return loadWorkspaceContext(key);
}

export function createApp(vite?: ViteDevServer) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'agentic-data-architect' });
  });

  app.get('/api/sessions', async (_req, res) => {
    res.json({ sessions: await listSessions() });
  });

  app.post('/api/sessions', async (req, res) => {
    const context = await createSession(req.body?.name, req.body?.userPrompt);
    res.status(201).json({ context });
  });

  app.get('/api/sessions/:name', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    res.json({
      context,
      messages: messagesFromContext(context),
    });
  });

  app.get('/api/sessions/:name/report', async (req, res) => {
    const name = sessionKey(req.params.name);
    const report = await buildReport(name);
    res.type('text/markdown').send(report.markdown);
  });

  app.get('/api/shared', async (_req, res) => {
    const indexFile = path.join(config.sharedDir, 'index.json');
    try {
      const raw = await fs.readFile(indexFile, 'utf8');
      res.type('application/json').send(raw);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ schemaVersion: 1, artifacts: [], updatedAt: new Date().toISOString() });
        return;
      }
      throw error;
    }
  });

  app.post('/api/sessions/:name/messages', async (req, res) => {
    const name = sessionKey(req.params.name);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    await ensureWorkspace(name);
    const result = await answerQuestion(name, message);
    res.json(result);
  });

  if (vite) {
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      try {
        const template = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
  } else {
    app.use(express.static(webDist));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    if (res.headersSent) return;
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  });

  return app;
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

  const app = createApp(vite);
  const server = createHttpServer(app);
  server.listen(config.port, config.host, () => {
    console.log(
      `Agentic Data Architect Web UI: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    );
  });

  const shutdown = async () => {
    server.close();
    await vite?.close();
    await stopClient();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
