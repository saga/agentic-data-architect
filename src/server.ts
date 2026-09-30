import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import {
  AbortBodySchema,
  CreateSessionBodySchema,
  MessageBodySchema,
  RequestValidationError,
  UpdateConfigBodySchema,
  parseRequest,
} from './api/schemas.js';
import { SharedIndexSchema } from './investigation/schemas.js';
import { answerQuestion, requestAbort } from './workflow/ask.js';
import { buildReport } from './analysis/report.js';
import { config } from './config.js';
import {
  appendContextInput,
  ensureWorkspace,
  loadWorkspaceContext,
  workspaceRoot,
} from './investigation/workspace.js';
import { investigationExists, newInvestigation, saveInvestigation } from './investigation/store.js';
import {
  closeConversationStore,
  recoverRunningConversationTurns,
  getConversationSummary,
  getConversationTurn,
  listConversationMessages,
  searchConversation,
} from './investigation/conversation.js';
import { abortCopilotTurn, stopClient } from './agent/copilot.js';
import {
  appendAuditEvent,
  loadInvestigationControl,
  readAuditEvents,
  updateInvestigationControl
} from './investigation/control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');
const webDist = path.join(webRoot, 'dist');

interface SessionSummary {
  key: string;
  label: string;
  userPrompt: string;
  updatedAt: string;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
});

function safeUploadName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  return base || 'uploaded-file';
}

async function listSkills(): Promise<Array<{ name: string; description: string }>> {
  let entries;
  try {
    entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: Array<{ name: string; description: string }> = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      const text = await fs.readFile(path.join(config.skillsDir, entry.name, 'SKILL.md'), 'utf8');
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() || entry.name;
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() || '';
      result.push({ name, description });
    } catch {
      // Ignore directories without SKILL.md.
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function sessionKey(name: string): string {
  const safe = path.basename(name);
  if (!name || safe !== name || name === '.' || name === '..') {
    throw new Error('Invalid session name');
  }
  return safe;
}

async function listSessions(): Promise<SessionSummary[]> {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  const entries = await fs.readdir(config.workspaceDir, { withFileTypes: true });
  const result: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'shared') continue;
    try {
      const context = await loadWorkspaceContext(entry.name);
      const conversation = getConversationSummary(entry.name);
      result.push({
        key: entry.name,
        label: context.userPrompt?.trim().slice(0, 60) || entry.name,
        userPrompt: context.userPrompt ?? '',
        updatedAt: conversation.lastMessageAt ?? context.updatedAt,
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
  await loadInvestigationControl(key);
  await appendAuditEvent(key, {
    actor: 'user',
    action: 'investigation.created',
    summary: 'Created investigation session.',
    details: { hasInitialPrompt: Boolean(userPrompt?.trim()) },
  });
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
    const body = parseRequest(CreateSessionBodySchema, req.body);
    const context = await createSession(body.name, body.userPrompt);
    res.status(201).json({ context });
  });

  app.get('/api/sessions/:name', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    const conversation = getConversationSummary(name);
    res.json({
      context,
      control: await loadInvestigationControl(name),
      recentAudit: await readAuditEvents(name, 8),
      messages: listConversationMessages(name, 200),
      conversationCount: conversation.count,
      conversationLastMessageAt: conversation.lastMessageAt ?? null,
    });
  });

  app.get('/api/skills', async (_req, res) => {
    res.json({ skills: await listSkills() });
  });

  app.get('/api/sessions/:name/audit', async (req, res) => {
    const name = sessionKey(req.params.name);
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    res.json({ events: await readAuditEvents(name, Number.isFinite(limit) ? limit : 100) });
  });

  app.put('/api/sessions/:name/config', async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    const body = parseRequest(UpdateConfigBodySchema, req.body);
    const control = await updateInvestigationControl(name, {
      research: body.research,
      agent: body.agent,
    });
    res.json({ control });
  });

  app.post('/api/sessions/:name/files', upload.single('file'), async (req, res) => {
    const name = sessionKey(String(req.params.name));
    if (!req.file) {
      res.status(400).json({ error: '没有收到文件，请重新选择要上传的文件。' });
      return;
    }

    const root = workspaceRoot(name);
    const uploadsDir = path.join(root, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });

    const originalName = safeUploadName(req.file.originalname);
    const storedName = randomUUID() + '-' + originalName;
    const relativePath = path.posix.join('uploads', storedName);
    const target = path.join(root, 'uploads', storedName);
    await fs.writeFile(target, req.file.buffer);

    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex');
    const input = await appendContextInput(name, {
      kind: 'document',
      title: req.file.originalname,
      source: 'user-upload',
      artifactPath: relativePath,
      important: false,
      mimeType: req.file.mimetype || 'application/octet-stream',
      sizeBytes: req.file.size,
      sha256,
    });

    await appendAuditEvent(name, {
      actor: 'user',
      action: 'file.uploaded',
      summary: 'Uploaded document to investigation workspace.',
      details: {
        inputId: input.id,
        title: req.file.originalname,
        artifactPath: relativePath,
        sizeBytes: req.file.size,
        mimeType: req.file.mimetype || 'application/octet-stream',
        sha256,
      },
    });

    res.status(201).json({
      input,
      file: {
        id: input.id,
        name: req.file.originalname,
        path: relativePath,
        size: req.file.size,
        mimeType: req.file.mimetype || 'application/octet-stream',
      },
    });
  });

  app.get('/api/sessions/:name/messages', async (req, res) => {
    const name = sessionKey(req.params.name);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const messages = query
      ? searchConversation(name, query, { limit: Number.isFinite(limit) ? limit : 50 })
      : listConversationMessages(name, Number.isFinite(limit) ? limit : 100);
    res.json({
      messages,
      search: query || null,
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
      const index = SharedIndexSchema.parse(JSON.parse(raw));
      res.json(index);
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
    const body = parseRequest(MessageBodySchema, req.body);
    await ensureWorkspace(name);
    const result = await answerQuestion(name, body.message, undefined, body.turnId);
    res.json(result);
  });

  app.post('/api/sessions/:name/messages/stream', async (req, res) => {
    const name = sessionKey(req.params.name);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const turnId = typeof req.body?.turnId === 'string' ? req.body.turnId.trim() : randomUUID();
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    await ensureWorkspace(name);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // SSE is the browser's live execution channel. answerQuestion commits the
    // durable result before the final "completed" event is sent.
    let finished = false;
    const send = (event: string, data: unknown) => {
      if (finished || res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('started', { turnId });
    const heartbeat = setInterval(() => send('heartbeat', { timestamp: new Date().toISOString() }), 15000);
    heartbeat.unref?.();

    // A disconnected browser behaves like Stop while execution is cancelable.
    // The commit phase intentionally ignores late cancellation.
    const onClose = () => {
      if (!finished) {
        requestAbort(name, turnId);
        void abortCopilotTurn(turnId);
      }
    };
    res.on('close', onClose);

    try {
      const result = await answerQuestion(
        name,
        message,
        (delta) => send('delta', { delta }),
        turnId,
        (status) => send('status', { status }),
      );
      send('completed', result);
      finished = true;
      res.end();
    } catch (error) {
      send('error', { error: error instanceof Error ? error.message : String(error) });
      finished = true;
      res.end();
    } finally {
      clearInterval(heartbeat);
      res.off('close', onClose);
    }
  });

  app.post('/api/sessions/:name/messages/abort', async (req, res) => {
    const name = sessionKey(req.params.name);
    const { turnId } = parseRequest(AbortBodySchema, req.body);
    const turn = getConversationTurn(turnId);
    if (!turn || turn.sessionName !== name) {
      res.status(404).json({ error: '找不到这次请求，请刷新页面后重试。' });
      return;
    }
    const requested = requestAbort(name, turnId);
    const aborted = requested || await abortCopilotTurn(turnId);
    res.json({ aborted });
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
    if (error instanceof RequestValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: '文件太大，单个文件最多 50 MB。' });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : '服务暂时无法处理这个请求，请稍后重试。',
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

  const recoveredTurns = recoverRunningConversationTurns();
  if (recoveredTurns > 0) console.warn(`Recovered ${recoveredTurns} interrupted investigation turn(s).`);

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
    closeConversationStore();
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
