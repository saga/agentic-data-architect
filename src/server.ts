/**
 * Web API 和 SSE 路由。
 *
 * 本文件只负责应用组装；HTTP/Vite 进程生命周期由 src/server-main.ts 负责。
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import {
  AbortBodySchema,
  CreateSessionBodySchema,
  MessageBodySchema,
  PermissionResponseBodySchema,
  RequestValidationError,
  UserInputResponseBodySchema,
  UpdateConfigBodySchema,
  UpdateWorkflowBodySchema,
  JourneyAiRequestSchema,
  JourneyTransitionBodySchema,
  parseRequest,
} from './api/schemas.js';
import { SharedIndexSchema } from './investigation/schemas.js';
import { answerQuestion, requestAbort } from './workflow/ask.js';
import { generateJourneyFlow } from './workflow/journey-ai.js';
import { JourneyDefinitionSchema } from './workflow/journey.js';
import {
  buildJourneyAgentInstruction,
  getJourneySnapshot,
  JourneyEditBodySchema,
  resetJourneyCustomization,
  saveJourneyDefinition,
  validateJourneyEdit,
  applyHumanWorkflowTransition,
} from './workflow/journey-editor.js';
import { readTrajectory, summarizeTrajectory, summarizeTrajectoryTurns } from './investigation/trajectory.js';
import { buildReport } from './analysis/report.js';
import { buildModernizationPlan, loadModernizationPlan } from './workflow/modernization.js';
import {
  buildArchitectureAssessmentPlan,
  loadArchitectureAssessmentPlan,
} from './workflow/assessment.js';
import { config } from './config.js';
import { closeLocalAnalytics, discoverLocalDatasets, listLocalDatasets, registerLocalDataset } from './analytics/local-data.js';
import {
  appendContextInput,
  ensureWorkspace,
  loadWorkspaceContext,
  workspaceRoot,
} from './investigation/workspace.js';
import { investigationExists, newInvestigation, saveInvestigation, loadLatestSnapshot, updateInvestigationWorkflow } from './investigation/store.js';
import {
  closeConversationStore,
  recoverRunningConversationTurns,
  getConversationSummary,
  getConversationTurn,
  listConversationMessages,
  listConversationTurns,
  searchConversation,
} from './investigation/conversation.js';
import {
  abortCopilotTurn,
  listPendingCopilotPermissions,
  listPendingCopilotUserInputs,
  respondToCopilotPermission,
  respondToCopilotUserInput,
  stopClient,
} from './agent/copilot.js';
import {
  appendAuditEvent,
  loadInvestigationControl,
  readAuditEvents,
  updateInvestigationControl
} from './investigation/control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');
const webDist = path.join(webRoot, 'dist');

/** Session 列表给 UI 使用的轻量摘要，避免每次列表请求都返回完整 Investigation。 */
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

/** 清理用户上传文件名，只保留安全文件名字符并限制长度。 */
function safeUploadName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  return base || 'uploaded-file';
}

/** 兼容 Express 路由参数可能为 string|string[] 的情况，统一取第一个值。 */
function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/** 校验 URL 中的 Session 名称，拒绝路径穿越。 */
function sessionKey(name: string): string {
  const safe = path.basename(name);
  if (!name || safe !== name || name === '.' || name === '..') {
    throw new Error('Invalid session name');
  }
  return safe;
}

/** 枚举 workspace 下的 Investigation，并组合 context 与 conversation 摘要返回给 UI。 */
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

/** 创建新的 Investigation、默认 Control 和初始审计事件；已存在时直接返回。 */
async function createSession(
  name?: string,
  userPrompt?: string,
  workflow?: 'legacy-modernization' | 'financial-ai-native-architecture' | 'data-architecture-assessment' | null,
) {
  const key = sessionKey(
    name?.trim() ||
      'session-' +
        new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
  );
  if (await investigationExists(key)) {
    return loadWorkspaceContext(key);
  }
  const investigation = newInvestigation(key, userPrompt?.trim() ?? '', workflow ?? null);
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

/** 创建 Express 应用和全部 Web API/SSE 路由；主进程负责 listen，这里只负责组装。 */
export function createApp(vite?: ViteDevServer) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // 健康检查：只验证 Web service 能正常响应，不触发模型或数据库连接。
app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'agentic-data-architect' });
  });

  // Session 列表 API：返回 UI 左侧历史 Investigation。
app.get('/api/sessions', async (_req, res) => {
    res.json({ sessions: await listSessions() });
  });

  // 创建 Session API：body 先经 Zod，再进入业务层。
app.post('/api/sessions', async (req, res) => {
    const body = parseRequest(CreateSessionBodySchema, req.body);
    const context = await createSession(body.name, body.userPrompt, body.workflow);
    res.status(201).json({ context });
  });

  app.get('/api/sessions/:name', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    const snapshot = await loadLatestSnapshot<any>(name);
    const conversation = getConversationSummary(name);
    res.json({
      context,
      control: await loadInvestigationControl(name),
      localDatasets: listLocalDatasets(name),
      recentAudit: await readAuditEvents(name, 8),
      messages: listConversationMessages(name, 200),
      conversationCount: conversation.count,
      conversationLastMessageAt: conversation.lastMessageAt ?? null,
      currentState: snapshot?.currentState ?? null,
      semanticAssets: snapshot?.semanticAssets ?? [],
    });
  });


  app.get('/api/sessions/:name/trajectory', async (req, res) => {
    const name = sessionKey(req.params.name);
    const turnId = typeof req.query.turnId === 'string' ? req.query.turnId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 1000;
    const events = await readTrajectory(name, {
      ...(turnId ? { turnId } : {}),
      limit: Number.isFinite(limit) ? limit : 1000,
    });
    const summary = summarizeTrajectory(events);
    const turns = summarizeTrajectoryTurns(events);
    const conversationTurns = listConversationTurns(name, 200);
    res.json({ events, summary, turns, conversationTurns });
  });

  /** 返回当前 Investigation 正在等待用户处理的 Agent 权限请求。 */
  app.get('/api/sessions/:name/permissions', async (req, res) => {
    const name = sessionKey(req.params.name);
    res.json({ permissions: listPendingCopilotPermissions(name) });
  });

  /** 处理一个待确认权限；允许后继续执行被暂停的 Agent 工具。 */
  app.post('/api/sessions/:name/permissions/respond', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(PermissionResponseBodySchema, req.body);
    const handled = await respondToCopilotPermission(name, body.turnId, body.requestId, body.allowed);
    if (!handled) {
      res.status(404).json({ error: '这个权限请求已经处理、已结束，或不属于当前执行。' });
      return;
    }
    await appendAuditEvent(name, {
      actor: 'user',
      action: body.allowed ? 'agent.permission.approved' : 'agent.permission.rejected',
      summary: body.allowed ? '用户允许 Agent 执行这次操作。' : '用户拒绝 Agent 执行这次操作。',
      details: {
        turnId: body.turnId,
        requestId: body.requestId,
      },
    });
    res.json({ ok: true });
  });

  /** 返回当前 Investigation 的 Agent 待回答问题。 */
  app.get('/api/sessions/:name/user-inputs', async (req, res) => {
    const name = sessionKey(req.params.name);
    res.json({ requests: listPendingCopilotUserInputs(name) });
  });

  /** 把用户回答交回 ask_user；Agent 会从等待的 Promise 继续执行。 */
  app.post('/api/sessions/:name/user-inputs/respond', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(UserInputResponseBodySchema, req.body);
    const handled = respondToCopilotUserInput(name, body.turnId, body.requestId, body.answer, body.wasFreeform);
    if (!handled) {
      res.status(404).json({ error: '这个用户输入请求已经处理、已结束，或答案不符合请求要求。' });
      return;
    }
    await appendAuditEvent(name, {
      actor: 'user',
      action: 'agent.user_input.answered',
      summary: '用户回答了 Agent 的问题。',
      details: {
        turnId: body.turnId,
        requestId: body.requestId,
        wasFreeform: body.wasFreeform,
      },
    });
    res.json({ ok: true });
  });

  app.get('/api/sessions/:name/audit', async (req, res) => {
    const name = sessionKey(req.params.name);
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    res.json({ events: await readAuditEvents(name, Number.isFinite(limit) ? limit : 100) });
  });

  app.patch('/api/sessions/:name/workflow', async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    const body = parseRequest(UpdateWorkflowBodySchema, req.body);
    const current = await loadWorkspaceContext(name);
    const context = await updateInvestigationWorkflow(name, body.workflow);
    if (current.workflow !== body.workflow) {
      await appendAuditEvent(name, {
        actor: 'user',
        action: 'investigation.workflow.changed',
        summary: 'Changed the investigation work mode.',
        details: {
          fromWorkflow: current.workflow,
          toWorkflow: body.workflow,
        },
      });
    }
    res.json({ context });
  });

  /** 返回当前 Workflow 给工作地图页面；页面打开后直接进入可编辑状态。 */
  app.get('/api/sessions/:name/workflow', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json({ error: '这个调查还没有选择工作方式，先到调查设置选择一种工作方式。' });
      return;
    }
    res.json(await getJourneySnapshot(name, context.workflow));
  });

  /** 保存工作地图；服务端先做完整结构检查，通过后才创建新版本。 */
  app.put('/api/sessions/:name/workflow', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json({ error: '这个调查还没有选择工作方式，先到调查设置选择一种工作方式。' });
      return;
    }

    const body = parseRequest(JourneyEditBodySchema, req.body);
    const validation = validateJourneyEdit(body.definition, body.layout);
    if (validation.issues.length) {
      res.status(400).json({
        error: '工作地图还不能保存，请先修正这些问题。',
        issues: validation.issues,
      });
      return;
    }

    const result = await saveJourneyDefinition(
      name,
      context.workflow,
      body.definition,
      body.layout,
    );
    res.json(result);
  });

  /** 工作地图专用 AI：只生成/修改 Workflow，不参与数据分析。 */
  app.post('/api/sessions/:name/workflow/ai', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json({ error: '这个调查还没有选择工作方式，先到调查设置选择一种工作方式。' });
      return;
    }

    const body = parseRequest(JourneyAiRequestSchema, req.body);
    const currentDefinition = body.definition === undefined
      ? undefined
      : JourneyDefinitionSchema.parse(body.definition);

    if (currentDefinition && currentDefinition.id !== context.workflow) {
      res.status(400).json({ error: '当前工作地图与所选 Workflow 不一致，请刷新后重试。' });
      return;
    }

    const result = await generateJourneyFlow(
      name,
      context.workflow,
      body.prompt,
      body.messages ?? [],
      currentDefinition,
      body.selectedNodeId,
    );
    res.json(result);
  });

  /** 人工完成 waiting 节点；与 Agent transition 共用 Workflow version 检查。 */
  app.post('/api/sessions/:name/workflow/transition', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json({ error: '这个调查还没有选择工作方式，无法推进 Workflow。' });
      return;
    }

    const body = parseRequest(JourneyTransitionBodySchema, req.body);
    const result = await applyHumanWorkflowTransition(
      name,
      context.workflow,
      body.nodeId,
      body.outcome,
    );
    if (!result.applied) {
      res.status(409).json({ error: result.error || 'Workflow 没有推进。' });
      return;
    }
    res.json(result);
  });

  /** 删除当前 Investigation 的自定义地图，恢复所选工作方式的内置路线。 */
  app.post('/api/sessions/:name/workflow/reset', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json({ error: '这个调查还没有选择工作方式，无法恢复工作地图。' });
      return;
    }
    res.json(await resetJourneyCustomization(name, context.workflow));
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

  // 文件上传 API：把文件存入当前 Investigation workspace，并记录 sha256/Evidence 输入。
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
    let dataset;
    try {
      dataset = await registerLocalDataset(name, relativePath, req.file.originalname);
    } catch {
      // 非分析文件继续按普通文档处理；CSV/JSON/JSONL/Parquet 会自动进入 Dataset Registry。
    }

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
        ...(dataset ? { dataset } : {}),
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
        ...(dataset ? { dataset } : {}),
      },
    });
  });

  app.get('/api/sessions/:name/datasets', async (req, res) => {
    const name = sessionKey(req.params.name);
    const refresh = req.query.refresh === 'true';
    const datasets = refresh
      ? await discoverLocalDatasets(name)
      : listLocalDatasets(name);
    res.json({
      datasets,
      engine: {
        type: 'duckdb',
        databaseFile: path.relative(workspaceRoot(name), path.join(workspaceRoot(name), 'local.duckdb')),
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

  /** 兼容旧 Journey UI；如果当前 Investigation 选择了 Workflow，统一返回当前 Workflow state。 */
  app.get('/api/sessions/:name/journey', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.json({ journey: null, routePlan: context.journeyPlan ?? null });
      return;
    }

    try {
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
      // /journey 是旧首页侧栏的兼容接口，不能因为历史自定义路线损坏而阻塞整个 Investigation 页面。
      // 真正的工作地图仍通过 /workflow 返回，并继续使用完整 validation，因此这里不静默修复 Definition。
      console.error('Failed to build legacy journey snapshot for session ' + name, error);
      res.json({
        journey: null,
        routePlan: context.journeyPlan ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /** 给调试/测试和普通 Agent 路径使用的当前 Workflow 控制摘要。 */
  app.get('/api/sessions/:name/workflow/instruction', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    res.type('text/plain').send(
      await buildJourneyAgentInstruction(name, context.workflow),
    );
  });

  app.get('/api/sessions/:name/assessment', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (context.workflow !== 'data-architecture-assessment') {
      res.json({ plan: null, path: null });
      return;
    }
    const rebuild = req.query.rebuild === 'true';
    const existing = await loadArchitectureAssessmentPlan(name);
    if (existing && !rebuild) {
      res.json({ plan: existing, path: null });
      return;
    }
    if (!existing && !rebuild) {
      res.json({ plan: null, path: null });
      return;
    }
    const result = await buildArchitectureAssessmentPlan(name);
    res.json(result);
  });

  app.get('/api/sessions/:name/modernization', async (req, res) => {
    const name = sessionKey(req.params.name);
    const rebuild = req.query.rebuild === 'true';
    const existing = await loadModernizationPlan(name);
    if (existing && !rebuild) {
      res.json({ plan: existing, path: null });
      return;
    }
    if (!existing && !rebuild) {
      res.json({ plan: null, path: null });
      return;
    }
    const result = await buildModernizationPlan(name);
    res.json(result);
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
    const context = await loadWorkspaceContext(name);
    let selectedRoute;
    const message = body.message
      ?? (() => {
        selectedRoute = context.journeyPlan?.routes.find((route) => route.id === body.routeId);
        return selectedRoute ? '选择下一步：' + selectedRoute.title : '';
      })();

    if (body.routeId && !selectedRoute) {
      res.status(409).json({ error: '这个下一步已经过期，请根据最新情况重新选择。' });
      return;
    }

    const result = await answerQuestion(
      name,
      message,
      undefined,
      body.turnId,
      undefined,
      selectedRoute ? { selectedRoute } : undefined,
    );
    res.json(result);
  });

  // Agent SSE API：把执行中的 delta/status/heartbeat/completed/error 实时推送给浏览器。
app.post('/api/sessions/:name/messages/stream', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(MessageBodySchema, req.body);
    const context = await loadWorkspaceContext(name);
    let selectedRoute = body.routeId
      ? context.journeyPlan?.routes.find((route) => route.id === body.routeId)
      : undefined;
    if (body.routeId && !selectedRoute) {
      res.status(409).json({ error: '这个下一步已经过期，请根据最新情况重新选择。' });
      return;
    }
    const message = body.message
      ?? (selectedRoute ? '选择下一步：' + selectedRoute.title : '');
    const turnId = body.turnId ?? randomUUID();

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
        selectedRoute ? { selectedRoute } : undefined,
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

  // Stop API：只允许取消当前可取消的 executing turn，commit 阶段不会被打断。
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
