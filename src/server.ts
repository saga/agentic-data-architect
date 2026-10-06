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
  UpdateAgentModelBodySchema,
  UpdateMissionBodySchema,
  UpdateWorkflowBodySchema,
  JourneyAiRequestSchema,
  JourneyTransitionBodySchema,
  parseRequest,
} from './api/schemas.js';
import { SharedIndexSchema } from './investigation/schemas.js';
import { answerQuestion, getActiveInvestigationTurn, requestAbort } from './workflow/ask.js';
import { generateJourneyFlow } from './workflow/journey-ai.js';
import { JourneyDefinitionSchema } from './workflow/journey.js';
import {
  SseEventSchema,
  ApiErrorSchema,
  ExecutionStatusSchema,
  TrajectoryResponseSchema,
  ArchitectureAssessmentResponseSchema,
  ModernizationResponseSchema,
  SessionsResponseSchema,
  SessionDataSchema,
  MissionResponseSchema,
  OpenCodeStatusSchema,
  ModelsResponseSchema,
  PermissionsResponseSchema,
  UserInputsResponseSchema,
  AuditResponseSchema,
  MessagesResponseSchema,
  DatasetsResponseSchema,
  WorkflowCompatibilityResponseSchema,
  AnswerSummarySchema,
  ReportRegenerateResponseSchema,
  ControlResponseSchema,
  HealthResponseSchema,
  CreateSessionResponseSchema,
  MissionUpdateResponseSchema,
  WorkflowContextResponseSchema,
  FileUploadResponseSchema,
  WorkflowInstructionResponseSchema,
  SimpleOkResponseSchema,
  type SseEvent,
} from './api/contracts.js';
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
import { readReport, runReport, ReportQualityGateError } from './workflow/report.js';
import { buildModernizationPlan, loadModernizationPlan, toModernizationPlanView } from './workflow/modernization.js';
import {
  buildArchitectureAssessmentPlan,
  loadArchitectureAssessmentPlan,
  toArchitectureAssessmentView,
} from './workflow/assessment.js';
import { config } from './config.js';
import { ScopeGateError } from './workflow/scope-gate.js';
import { ReportGateError } from './workflow/report-gate.js';

import {
  buildMissionDraft,
  evaluateMissionGate,
  formatMissionGateFailure,
  inferMissionDeliverables,
  MissionGateError,
} from './workflow/mission-gate.js';
import { reviewMissionClarity } from './workflow/mission-evaluation.js';
import { buildMissionProgress } from './workflow/mission-progress.js';
import { closeLocalAnalytics, discoverLocalDatasets, listLocalDatasets, registerLocalDataset } from './analytics/local-data.js';
import {
  appendContextInput,
  appendTranscript,
  ensureWorkspace,
  loadWorkspaceContext,
  workspaceRoot,
} from './investigation/workspace.js';
import {
  investigationExists,
  newInvestigation,
  saveInvestigation,
  loadLatestSnapshot,
  updateInvestigationWorkflow,
  confirmInvestigationMission,
} from './investigation/store.js';
import {
  closeConversationStore,
  recoverRunningConversationTurns,
  getConversationSummary,
  getConversationTurn,
  listConversationMessages,
  listConversationTurns,
  saveConversationMessage,
  searchConversation,
} from './investigation/conversation.js';
import {
  abortCopilotTurn,
  getClient,
  listPendingCopilotPermissions,
  listPendingCopilotUserInputs,
  respondToCopilotPermission,
  respondToCopilotUserInput,
  stopClient,
} from './agent/copilot.js';
import { listOpenCodeModels, abortOpenCodeTurn } from './agent/opencode.js';
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
        label: context.mission?.purpose?.trim().slice(0, 60)
          || context.userPrompt?.trim().slice(0, 60)
          || entry.name,
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

  // 新 Investigation 继承工作台最近配置的默认头像，避免每次新建调查都退回机器人图标。
  // 头像文件仍复制到当前 Investigation，保持现有“每个调查独立资料”的边界。
  const control = await loadInvestigationControl(key);
  const defaultAvatarMetaPath = path.join(config.sharedDir, 'assistant', 'default.json');
  try {
    const meta = JSON.parse(await fs.readFile(defaultAvatarMetaPath, 'utf8')) as {
      sourcePath?: string;
      width?: number;
      height?: number;
      mimeType?: string;
    };
    if (meta.sourcePath) {
      const sourcePath = path.resolve(config.sharedDir, meta.sourcePath);
      const sharedRoot = path.resolve(config.sharedDir);
      if (sourcePath === sharedRoot || !sourcePath.startsWith(sharedRoot + path.sep)) {
        throw new Error('默认头像路径无效。');
      }
      const avatarId = randomUUID();
      const extension = path.extname(sourcePath).slice(1).toLowerCase() || 'png';
      const mimeByExtension: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
      };
      const relativePath = path.posix.join('assistant', 'avatars', avatarId + '.' + extension);
      const targetPath = path.join(workspaceRoot(key), relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      const inherited = await updateInvestigationControl(
        key,
        {
          research: control.research,
          agent: {
            ...control.agent,
            avatarPath: relativePath,
            avatarPaths: [relativePath],
            avatarMimeType: meta.mimeType ?? mimeByExtension[extension] ?? control.agent.avatarMimeType,
            avatarWidth: Number.isFinite(meta.width) ? Math.max(40, Math.min(800, Math.round(meta.width!))) : control.agent.avatarWidth,
            avatarHeight: Number.isFinite(meta.height) ? Math.max(40, Math.min(1200, Math.round(meta.height!))) : control.agent.avatarHeight,
          },
        },
        'inherited default assistant avatar',
      );
      void inherited;
    }
  } catch (error) {
    // 没有配置默认头像是正常情况；不能因此阻止新调查创建。
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await appendAuditEvent(key, {
    actor: 'user',
    action: 'investigation.created',
    summary: 'Created investigation session.',
    details: { hasInitialPrompt: Boolean(userPrompt?.trim()) },
  });
  return loadWorkspaceContext(key);
}

/**
 * Mission 尚未确认时也要先保留用户已经发送的消息。
 *
 * Mission Gate 负责阻止 Agent 执行，而不是删除用户对话。使用 turnId:user
 * 作为稳定消息 ID，使确认 Mission 后重试同一个 turn 时不会产生重复用户消息。
 */
async function preserveBlockedUserMessage(
  sessionName: string,
  turnId: string,
  message: string,
): Promise<void> {
  const content = message.trim();
  if (!content) return;

  saveConversationMessage({
    id: turnId + ':user',
    sessionName,
    role: 'user',
    content,
  });
  await appendContextInput(sessionName, {
    kind: 'user_message',
    title: '用户问题',
    content,
    source: 'conversation',
    important: false,
  });
  await appendTranscript(sessionName, 'user', content);
}

/** 创建 Express 应用和全部 Web API/SSE 路由；主进程负责 listen，这里只负责组装。 */
export function createApp(vite?: ViteDevServer) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // 健康检查：只验证 Web service 能正常响应，不触发模型或数据库连接。
app.get('/api/health', (_req, res) => {
    res.json(HealthResponseSchema.parse({ ok: true, service: 'agentic-data-architect' }));
  });

  // Session 列表 API：返回 UI 左侧历史 Investigation。
app.get('/api/sessions', async (_req, res) => {
    res.json(SessionsResponseSchema.parse({ sessions: await listSessions() }));
  });

  // 创建 Session API：body 先经 Zod，再进入业务层。
app.post('/api/sessions', async (req, res) => {
    const body = parseRequest(CreateSessionBodySchema, req.body);
    const context = await createSession(body.name, body.userPrompt, body.workflow);
    res.status(201).json(CreateSessionResponseSchema.parse({ context }));
  });

  app.get('/api/sessions/:name', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    const snapshot = await loadLatestSnapshot<any>(name);
    const conversation = getConversationSummary(name);
    const missionProgress = await buildMissionProgress(name, context.mission);
    const current = snapshot?.currentState;
    res.json(SessionDataSchema.parse({
      context,
      missionProgress,
      control: await loadInvestigationControl(name),
      localDatasets: listLocalDatasets(name),
      recentAudit: await readAuditEvents(name, 8),
      messages: listConversationMessages(name, 200).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        capturedAt: message.createdAt,
      })),
      conversationCount: conversation.count,
      conversationLastMessageAt: conversation.lastMessageAt ?? null,
      currentState: current ? {
        coverage: {
          datasets: current.coverage.datasets,
          connectedDatasets: current.coverage.connectedDatasets,
          datasetLineageConnectionRate: current.coverage.datasetLineageConnectionRate,
          sqlParseFailures: current.coverage.sqlParseFailures,
          semanticAssets: current.coverage.semanticAssets,
          profiledDatasets: current.coverage.profiledDatasets,
        },
        sourceOfTruthCandidates: current.sourceOfTruthCandidates,
        semanticCandidates: current.semanticCandidates,
        highValueAssets: current.highValueAssets,
      } : null,
      semanticAssets: snapshot?.semanticAssets ?? [],
    }));
  });


  /** 返回当前 Mission；没有确认 Mission 时同时提供可编辑候选。 */
  app.get('/api/sessions/:name/mission', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    const gate = evaluateMissionGate(context.mission);
    const progress = await buildMissionProgress(name, context.mission);
    res.json(MissionResponseSchema.parse({
      mission: context.mission ?? null,
      gate,
      progress,
      ...(context.mission ? {} : {
        draft: buildMissionDraft(context.goal || context.userPrompt),
      }),
    }));
  });

  /** 用户确认 Mission；这是解除 Mission Gate 的唯一接口。 */
  app.patch('/api/sessions/:name/mission', async (req, res) => {
    const name = sessionKey(req.params.name);
    const activeTurn = getActiveInvestigationTurn(name);
    if (activeTurn) {
      res.status(409).json({
        code: 'MISSION_CHANGE_BLOCKED',
        error: '本次调查正在执行，任务目标不能在执行中途修改。请先停止当前执行，再修改任务目的或期望结果。',
        execution: activeTurn,
      });
      return;
    }

    const body = parseRequest(UpdateMissionBodySchema, req.body);
    const clarity = await reviewMissionClarity(
      body.purpose,
      body.expectedResult,
      { model: (await loadInvestigationControl(name)).agent.model, workingDirectory: workspaceRoot(name) },
    );
    if (clarity && !clarity.clear) {
      res.status(409).json({
        code: 'MISSION_CLARITY_REQUIRED',
        error: clarity.reason,
        clarity,
        draft: buildMissionDraft(body.purpose, body.expectedResult),
      });
      return;
    }

    const mission = {
      version: 1 as const,
      purpose: body.purpose,
      expectedResult: body.expectedResult,
      deliverables: inferMissionDeliverables(body.purpose, body.expectedResult),
      status: 'confirmed' as const,
      confirmedAt: new Date().toISOString(),
      confirmedBy: 'user' as const,
    };

    const context = await confirmInvestigationMission(name, mission);
    await appendAuditEvent(name, {
      actor: 'user',
      action: 'investigation.mission.confirmed',
      summary: 'Confirmed the Investigation Mission Contract.',
      details: {
        purpose: mission.purpose,
        expectedResult: mission.expectedResult,
        deliverableIds: mission.deliverables.map((item) => item.id),
      },
    });

    res.json({
      context,
      mission,
      gate: evaluateMissionGate(mission),
      progress: await buildMissionProgress(name, mission),
    });
  });

  /**
   * 当前 Investigation 的 live execution state。
   * trajectory.jsonl 是历史记录，不能用来判断“现在是否还在跑”。
   */
  /** 返回本机 OpenCode 连接状态，不返回密码等敏感配置。 */
  app.get('/api/opencode/status', async (_req, res) => {
    if (!config.openCodeEnabled) {
      res.json(OpenCodeStatusSchema.parse({
        enabled: false,
        reachable: false,
        baseUrl: config.openCodeBaseUrl,
        modelCount: 0,
      }));
      return;
    }

    try {
      const models = await listOpenCodeModels();
      res.json(OpenCodeStatusSchema.parse({
        enabled: true,
        reachable: true,
        baseUrl: config.openCodeBaseUrl,
        modelCount: models.length,
      }));
    } catch (error) {
      res.json(OpenCodeStatusSchema.parse({
        enabled: true,
        reachable: false,
        baseUrl: config.openCodeBaseUrl,
        modelCount: 0,
        error: error instanceof Error ? error.message : 'OpenCode 服务不可用。',
      }));
    }
  });

  /**
   * 返回工作台可用模型。
   *
   * Copilot 和本机 OpenCode 是两个独立来源；任意一个暂时不可用都不应该阻塞另一个。
   * OpenCode 模型统一加 `opencode:` 前缀，前端选择后会自动切换运行时。
   */
  app.get('/api/copilot/models', async (_req, res) => {
    const models: Array<{
      id: string;
      name: string;
      supportedReasoningEfforts: string[];
      defaultReasoningEffort: string | null;
      policyState: string | null;
      runtime: 'copilot' | 'opencode';
    }> = [];

    try {
      const copilotModels = await (await getClient()).listModels();
      models.push(...copilotModels.map((model) => ({
        id: model.id,
        name: model.name,
        supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
        defaultReasoningEffort: model.defaultReasoningEffort ?? null,
        policyState: model.policy?.state ?? null,
        runtime: 'copilot' as const,
      })));
    } catch {
      // Copilot 登录/服务异常时仍然允许本机 OpenCode 工作。
    }

    try {
      const openCodeModels = await listOpenCodeModels();
      models.push(...openCodeModels.map((model) => ({
        id: model.id,
        name: model.name,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        policyState: null,
        runtime: 'opencode' as const,
      })));
    } catch {
      // OpenCode 未启动很常见；模型菜单仍然可以正常显示 Copilot。
    }

    res.json(ModelsResponseSchema.parse({ models }));
  });

  app.get('/api/sessions/:name/execution', async (req, res) => {
    const name = sessionKey(req.params.name);
    const active = getActiveInvestigationTurn(name);
    if (!active) {
      res.json(ExecutionStatusSchema.parse({ state: 'idle', running: false, turnId: null, phase: null, pendingPermissionCount: 0, pendingUserInputCount: 0, startedAt: null, lastActivityAt: null, lastActivity: null }));
      return;
    }
    const pendingPermissions = listPendingCopilotPermissions(name);
    const pendingUserInputs = listPendingCopilotUserInputs(name);
    const state = active.phase === 'committing'
      ? 'committing'
      : pendingPermissions.length > 0
        ? 'waiting_permission'
        : pendingUserInputs.length > 0
          ? 'waiting_user_input'
          : 'running';
    res.json(ExecutionStatusSchema.parse({
      state,
      running: true,
      turnId: active.turnId,
      phase: active.phase,
      pendingPermissionCount: pendingPermissions.length,
      pendingUserInputCount: pendingUserInputs.length,
      startedAt: null,
      lastActivityAt: null,
      lastActivity: null,
    }));
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
    const conversationStatus = new Map(conversationTurns.map((turn) => [turn.turnId, turn.status]));
    const normalizedTurns = turns.map((turn) => {
      const status = conversationStatus.get(turn.turnId);
      if (status === 'aborted' && turn.summary.state !== 'completed') {
        return {
          ...turn,
          summary: {
            ...turn.summary,
            state: 'aborted' as const,
            finishedAt: turn.summary.finishedAt ?? turn.summary.lastActivityAt,
          },
        };
      }
      return turn;
    });
    res.json({ events, summary, turns: normalizedTurns, conversationTurns });
  });

  /** 返回当前 Investigation 正在等待用户处理的 Agent 权限请求。 */
  app.get('/api/sessions/:name/permissions', async (req, res) => {
    const name = sessionKey(req.params.name);
    res.json(PermissionsResponseSchema.parse({ permissions: listPendingCopilotPermissions(name) }));
  });

  /** 处理一个待确认权限；允许后继续执行被暂停的 Agent 工具。 */
  app.post('/api/sessions/:name/permissions/respond', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(PermissionResponseBodySchema, req.body);
    const handled = await respondToCopilotPermission(
      name,
      body.turnId,
      body.requestId,
      body.allowed,
      body.scope,
    );
    if (!handled) {
      res.status(404).json({ error: '这个权限请求已经处理、已结束，或不属于当前执行。' });
      return;
    }
    await appendAuditEvent(name, {
      actor: 'user',
      action: body.allowed
        ? (body.scope === 'session' ? 'agent.permission.approved_for_session' : 'agent.permission.approved')
        : 'agent.permission.rejected',
      summary: body.allowed
        ? (body.scope === 'session'
          ? '用户允许 Agent 执行这次操作，并允许当前 Copilot Session 后续继续执行权限操作。'
          : '用户允许 Agent 执行这次操作。')
        : '用户拒绝 Agent 执行这次操作。',
      details: {
        turnId: body.turnId,
        requestId: body.requestId,
        scope: body.scope,
      },
    });
    res.json({ ok: true });
  });

  /** 返回当前 Investigation 的 Agent 待回答问题。 */
  app.get('/api/sessions/:name/user-inputs', async (req, res) => {
    const name = sessionKey(req.params.name);
    res.json(UserInputsResponseSchema.parse({ requests: listPendingCopilotUserInputs(name) }));
  });

  /** 把用户回答交回 ask_user；Agent 会从等待的 Promise 继续执行。 */
  app.post('/api/sessions/:name/user-inputs/respond', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(UserInputResponseBodySchema, req.body);
    const pending = listPendingCopilotUserInputs(name).find(
      (item) => item.turnId === body.turnId && item.requestId === body.requestId,
    );
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
        ...(pending?.question ? { question: pending.question } : {}),
        answer: body.answer.trim().slice(0, 2000),
        wasFreeform: body.wasFreeform,
      },
    });
    res.json({ ok: true });
  });

  app.get('/api/sessions/:name/audit', async (req, res) => {
    const name = sessionKey(req.params.name);
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    res.json(AuditResponseSchema.parse({ events: await readAuditEvents(name, Number.isFinite(limit) ? limit : 100) }));
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


  /** 主对话框切换模型 / Auto 选择方式；保存后从下一轮对话开始使用。 */
  app.patch('/api/sessions/:name/agent/model', async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    const body = parseRequest(UpdateAgentModelBodySchema, req.body);
    const current = await loadInvestigationControl(name);
    if (body.model !== 'auto' && body.autoTier) {
      res.status(400).json({ error: '只有选择 Auto 时才能设置自动选择方式。' });
      return;
    }
    const control = await updateInvestigationControl(
      name,
      {
        research: current.research,
        agent: {
          ...current.agent,
          model: body.model,
          ...(body.autoTier ? { autoTier: body.autoTier } : body.autoTier === null ? { autoTier: undefined } : {}),
        },
      },
      'model settings changed from main chat',
    );
    res.json({ control });
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

  /** 上传当前 Investigation 的秘书头像；每次上传生成独立文件，不覆盖已有头像。 */
  app.post('/api/sessions/:name/assistant/avatar', upload.single('file'), async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    if (!req.file) {
      res.status(400).json({ error: '没有收到头像文件，请重新选择。' });
      return;
    }
    const allowedAvatarTypes = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime',
    ]);
    if (!allowedAvatarTypes.has(req.file.mimetype)) {
      res.status(400).json({ error: '头像只支持 PNG、JPEG、WebP、GIF、MP4、WebM 或 MOV。' });
      return;
    }
    if (req.file.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: '头像文件过大，请重新裁剪后上传。' });
      return;
    }

    const root = workspaceRoot(name);
    const avatarDir = path.join(root, 'assistant', 'avatars');
    await fs.mkdir(avatarDir, { recursive: true });
    const avatarId = randomUUID();
    const extensionByMime: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    };
    const extension = extensionByMime[req.file.mimetype] ?? 'bin';
    const relativePath = path.posix.join('assistant', 'avatars', avatarId + '.' + extension);
    const avatarPath = path.join(root, relativePath);
    await fs.writeFile(avatarPath, req.file.buffer);

    // 同步更新工作台默认头像。之后新建的 Investigation 会继承这张头像。
    const sharedAvatarDir = path.join(config.sharedDir, 'assistant');
    await fs.mkdir(sharedAvatarDir, { recursive: true });
    const sharedAvatarPath = path.join(sharedAvatarDir, 'default.' + extension);
    const sharedMetaPath = path.join(sharedAvatarDir, 'default.json');
    await fs.copyFile(avatarPath, sharedAvatarPath);

    const current = await loadInvestigationControl(name);
    const requestedWidth = Number(req.body?.width);
    const requestedHeight = Number(req.body?.height);
    const avatarWidth = Number.isInteger(requestedWidth) && requestedWidth >= 40 && requestedWidth <= 800
      ? requestedWidth : current.agent.avatarWidth;
    const avatarHeight = Number.isInteger(requestedHeight) && requestedHeight >= 40 && requestedHeight <= 1200
      ? requestedHeight : current.agent.avatarHeight;
    const avatarPaths = [...new Set([
      ...(current.agent.avatarPaths ?? (current.agent.avatarPath ? [current.agent.avatarPath] : [])),
      relativePath,
    ])];

    const control = await updateInvestigationControl(
      name,
      {
        research: current.research,
        agent: {
          ...current.agent,
          // avatarPaths 是完整头像池；avatarPath 保留原来的默认头像，不能随着每次上传被替换。
          avatarPath: current.agent.avatarPath ?? relativePath,
          avatarPaths,
          avatarMimeType: req.file.mimetype || 'application/octet-stream',
          avatarWidth,
          avatarHeight,
        },
      },
      'assistant avatar added',
    );

    await fs.writeFile(
      sharedMetaPath,
      JSON.stringify({
        sourcePath: 'assistant/default.' + extension,
        mimeType: req.file.mimetype || 'application/octet-stream',
        width: control.agent.avatarWidth,
        height: control.agent.avatarHeight,
      }, null, 2) + '\n',
      'utf8',
    );

    await appendAuditEvent(name, {
      actor: 'user',
      action: 'assistant.avatar.added',
      summary: 'Added an investigation assistant avatar.',
      configurationVersion: control.version,
      details: {
        avatarPath: relativePath,
        avatarCount: avatarPaths.length,
        avatarWidth: control.agent.avatarWidth,
        avatarHeight: control.agent.avatarHeight,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
      },
    });

    res.json({ control });
  });

  /** 返回指定秘书头像；只允许访问当前 Control 中登记过的头像文件。 */
  app.get('/api/sessions/:name/assistant/avatar/:avatarId', async (req, res) => {
    const name = sessionKey(req.params.name);
    const avatarId = String(req.params.avatarId);
    if (!/^[0-9a-f-]+$/i.test(avatarId)) {
      res.status(400).end();
      return;
    }
    const control = await loadInvestigationControl(name);
    const avatarPaths = control.agent.avatarPaths ?? (control.agent.avatarPath ? [control.agent.avatarPath] : []);
    const relativePath = avatarPaths.find((item) => path.basename(item, path.extname(item)) === avatarId);
    if (!relativePath) {
      res.status(404).end();
      return;
    }

    try {
      const buffer = await fs.readFile(path.join(workspaceRoot(name), relativePath));
      const mimeByExtension: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      };
      res.setHeader('Content-Type', mimeByExtension[path.extname(relativePath).toLowerCase()] ?? control.agent.avatarMimeType ?? 'application/octet-stream');
      res.setHeader('Content-Length', buffer.byteLength);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.end(buffer);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).end();
        return;
      }
      throw error;
    }
  });

  /** 兼容旧版单头像 URL：旧 Control 中的 avatar.png 仍然可以显示。 */
  app.get('/api/sessions/:name/assistant/avatar', async (req, res) => {
    const name = sessionKey(req.params.name);
    const control = await loadInvestigationControl(name);
    const relativePath = control.agent.avatarPath;
    if (!relativePath) {
      res.status(404).end();
      return;
    }
    try {
      const buffer = await fs.readFile(path.join(workspaceRoot(name), relativePath));
      res.setHeader('Content-Type', control.agent.avatarMimeType ?? 'image/png');
      res.setHeader('Content-Length', buffer.byteLength);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.end(buffer);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).end();
        return;
      }
      throw error;
    }
  });

  app.get('/api/sessions/:name/datasets', async (req, res) => {
    const name = sessionKey(req.params.name);
    const refresh = req.query.refresh === 'true';
    const datasets = refresh
      ? await discoverLocalDatasets(name)
      : listLocalDatasets(name);
    res.json(DatasetsResponseSchema.parse({
      datasets,
      engine: {
        type: 'duckdb',
        databaseFile: path.relative(workspaceRoot(name), path.join(workspaceRoot(name), 'local.duckdb')),
      },
    }));
  });

  app.get('/api/sessions/:name/messages', async (req, res) => {
    const name = sessionKey(req.params.name);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const messages = query
      ? searchConversation(name, query, { limit: Number.isFinite(limit) ? limit : 50 })
      : listConversationMessages(name, Number.isFinite(limit) ? limit : 100);
    res.json(MessagesResponseSchema.parse({
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        capturedAt: message.createdAt,
      })),
      search: query || null,
    }));
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
      res.json(WorkflowCompatibilityResponseSchema.parse({
        // Compatibility projection only; canonical workflow state is /workflow.
        journey: { ...snapshot.state, execution: snapshot.execution },
        routePlan: context.journeyPlan ?? null,
        workflow: {
          source: snapshot.source,
          baseWorkflowId: snapshot.baseWorkflowId,
          version: snapshot.version,
        },
      }));
    } catch (error) {
      // /journey 是旧首页侧栏的兼容接口，不能因为历史自定义路线损坏而阻塞整个 Investigation 页面。
      // 真正的工作地图仍通过 /workflow 返回，并继续使用完整 validation，因此这里不静默修复 Definition。
      console.error('Failed to build legacy journey snapshot for session ' + name, error);
      res.json(WorkflowCompatibilityResponseSchema.parse({
        journey: null,
        routePlan: context.journeyPlan ?? null,
        error: error instanceof Error ? error.message : String(error),
      }));
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
      res.json(ArchitectureAssessmentResponseSchema.parse({ plan: null, path: null }));
      return;
    }
    const existing = await loadArchitectureAssessmentPlan(name);
    res.json(ArchitectureAssessmentResponseSchema.parse({
      plan: existing ? toArchitectureAssessmentView(existing) : null,
      path: null,
    }));
  });

  app.post('/api/sessions/:name/assessment/regenerate', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (context.workflow !== 'data-architecture-assessment') {
      res.status(409).json(ApiErrorSchema.parse({
        code: 'PRECONDITION_FAILED',
        error: '当前调查没有选择 Data Architecture Assessment 工作方式。',
      }));
      return;
    }
    try {
      const result = await buildArchitectureAssessmentPlan(name);
      res.json(ArchitectureAssessmentResponseSchema.parse({
        plan: toArchitectureAssessmentView(result.plan),
        path: result.path,
      }));
    } catch (error) {
      if (error instanceof ScopeGateError || error instanceof MissionGateError) {
        res.status(409).json(ApiErrorSchema.parse({
          code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : 'SCOPE_REQUIRED',
          error: error.message,
          details: { checks: error.result.checks },
        }));
        return;
      }
      throw error;
    }
  });

  app.get('/api/sessions/:name/modernization', async (req, res) => {
    const name = sessionKey(req.params.name);
    const existing = await loadModernizationPlan(name);
    res.json(ModernizationResponseSchema.parse({
      plan: existing ? toModernizationPlanView(existing) : null,
      path: null,
    }));
  });

  app.post('/api/sessions/:name/modernization/regenerate', async (req, res) => {
    const name = sessionKey(req.params.name);
    try {
      const result = await buildModernizationPlan(name);
      res.json(ModernizationResponseSchema.parse({
        plan: toModernizationPlanView(result.plan),
        path: result.path,
      }));
    } catch (error) {
      if (error instanceof ScopeGateError || error instanceof MissionGateError) {
        res.status(409).json(ApiErrorSchema.parse({
          code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : 'SCOPE_REQUIRED',
          error: error.message,
          details: { checks: error.result.checks },
        }));
        return;
      }
      throw error;
    }
  });

  app.get('/api/sessions/:name/report', async (req, res) => {
    const name = sessionKey(req.params.name);
    const report = await readReport(name);
    if (report.status === 'current' && report.markdown) {
      res.type('text/markdown').send(report.markdown);
      return;
    }
    if (report.status === 'missing') {
      res.status(404).json({ code: 'REPORT_NOT_GENERATED', error: '还没有生成正式报告，请显式重新生成。' });
      return;
    }
    if (report.status === 'stale') {
      res.status(409).json({ code: 'REPORT_STALE', error: '正式报告对应的调查成果已经变化，需要重新生成。' });
      return;
    }
    if (report.status === 'blocked') {
      res.status(409).json({
        code: report.reviewStatus === 'unavailable' ? 'REPORT_REVIEW_UNAVAILABLE' : 'REPORT_REVIEW_REQUIRED',
        error: '正式报告尚未通过独立质量审核，不能作为当前结果发布。',
      });
      return;
    }
    res.status(500).json({ code: 'REPORT_METADATA_INVALID', error: '正式报告的元数据无效，需要重新生成。' });
  });

  app.post('/api/sessions/:name/report/regenerate', async (req, res) => {
    const name = sessionKey(req.params.name);
    try {
      const result = await runReport(name);
      res.json(ReportRegenerateResponseSchema.parse({
        markdown: result.markdown,
        path: result.path,
        review: result.review,
      }));
    } catch (error) {
      if (error instanceof ScopeGateError || error instanceof MissionGateError || error instanceof ReportGateError) {
        res.status(409).json({
          code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : error instanceof ReportGateError ? 'REPORT_PRECONDITION_FAILED' : 'SCOPE_REQUIRED',
          error: error.message,
          details: error.result.checks,
        });
        return;
      }
      if (error instanceof ReportQualityGateError) {
        res.status(409).json({
          code: error.review.availability === 'unavailable' ? 'REPORT_REVIEW_UNAVAILABLE' : 'REPORT_REVIEW_FAILED',
          error: error.message,
        });
        return;
      }
      throw error;
    }
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

    const missionGate = evaluateMissionGate(context.mission);
    if (!missionGate.passed) {
      const blockedTurnId = body.turnId ?? randomUUID();
      await preserveBlockedUserMessage(name, blockedTurnId, message);
      res.status(409).json({
        code: 'MISSION_REQUIRED',
        error: formatMissionGateFailure(missionGate),
        draft: buildMissionDraft(context.goal || context.userPrompt),
        turnId: blockedTurnId,
      });
      return;
    }

    const result = await answerQuestion(
      name,
      message,
      undefined,
      body.turnId,
      undefined,
      selectedRoute ? { selectedRoute } : body.guided ? { selectedGuidance: message } : undefined,
    );
    res.json(result);
  });

  // Agent SSE API：把执行中的 delta/status/heartbeat/completed/error 实时推送给浏览器。
app.post('/api/sessions/:name/messages/stream', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(MessageBodySchema, req.body);
    await ensureWorkspace(name);
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

    const missionGate = evaluateMissionGate(context.mission);
    if (!missionGate.passed) {
      const blockedTurnId = body.turnId ?? randomUUID();
      await preserveBlockedUserMessage(name, blockedTurnId, message);
      res.status(409).json({
        code: 'MISSION_REQUIRED',
        error: formatMissionGateFailure(missionGate),
        draft: buildMissionDraft(context.goal || context.userPrompt),
        turnId: blockedTurnId,
      });
      return;
    }

    const turnId = body.turnId ?? randomUUID();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // SSE is the browser's live execution channel. answerQuestion commits the
    // durable result before the final "completed" event is sent.
    let finished = false;
    const send = (event: SseEvent['event'], data: unknown) => {
      if (finished || res.writableEnded) return;
      const payload = SseEventSchema.parse({ event, data });
      res.write(`event: ${payload.event}\n`);
      res.write(`data: ${JSON.stringify(payload.data)}\n\n`);
    };

    send('started', { turnId });
    const heartbeat = setInterval(() => send('heartbeat', { timestamp: new Date().toISOString() }), 15000);
    heartbeat.unref?.();

    // SSE 只是实时显示通道，浏览器切页、刷新或短暂断线不能意外终止 Agent。
    // 真正的 Stop 必须由显式的 /messages/abort 请求触发；新的页面可以继续通过
    // trajectory / pending-interaction API 查看运行态。
    try {
      const result = await answerQuestion(
        name,
        message,
        (delta) => send('delta', { delta }),
        turnId,
        (status) => send('status', { status }),
        {
          ...(selectedRoute ? { selectedRoute } : {}),
          ...(body.guided && !selectedRoute ? { selectedGuidance: message } : {}),
          onReasoningDelta: (delta) => send('reasoning', { delta }),
          onCheckpoint: (checkpoint) => send('checkpoint', checkpoint),
          onCompanionNote: (note) => send('companion_note', { note }),
        },
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
    const aborted = requested || await abortCopilotTurn(turnId) || await abortOpenCodeTurn(turnId);
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
      res.status(400).json(ApiErrorSchema.parse({ code: 'VALIDATION_ERROR', error: error.message }));
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json(ApiErrorSchema.parse({ code: 'PAYLOAD_TOO_LARGE', error: '文件太大，单个文件最多 50 MB。' }));
      return;
    }
    if (error instanceof ScopeGateError || error instanceof MissionGateError || error instanceof ReportGateError) {
      res.status(409).json(ApiErrorSchema.parse({
        code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : error instanceof ScopeGateError ? 'SCOPE_REQUIRED' : 'REPORT_PRECONDITION_FAILED',
        error: error.message,
        details: { checks: error.result.checks },
      }));
      return;
    }
    res.status(500).json(ApiErrorSchema.parse({
      code: 'INTERNAL_ERROR',
      error: error instanceof Error ? error.message : '服务暂时无法处理这个请求，请稍后重试。',
    }));
  });

  return app;
}
