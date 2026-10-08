/**
 * Web API 和 SSE 路由。
 *
 * 本文件只负责应用组装；HTTP/Vite 进程生命周期由 src/server-main.ts 负责。
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
  UpdateGlobalConfigBodySchema,
  UpdateAgentModelBodySchema,
  UpdateMissionBodySchema,
  UpdateWorkflowBodySchema,
  JourneyAiRequestSchema,
  JourneyTransitionBodySchema,
  parseRequest,
} from './api/schemas.js';
import { SharedIndexSchema } from './investigation/schemas.js';
import { answerQuestion, getActiveInvestigationTurn, requestAbort } from './workflow/ask.js';
import { abortCodeBuddyTurn } from './agent/codebuddy.js';
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
  AgentCatalogResponseSchema,
  AgentRuntimeSchema,
  PermissionsResponseSchema,
  UserInputsResponseSchema,
  AuditResponseSchema,
  MessagesResponseSchema,
  DatasetsResponseSchema,
  AnswerSummarySchema,
  ReportRegenerateResponseSchema,
  ReportArtifactStateSchema,
  ControlResponseSchema,
  toControlView,
  HealthResponseSchema,
  CreateSessionResponseSchema,
  MissionUpdateResponseSchema,
  WorkflowContextResponseSchema,
  FileUploadResponseSchema,
  WorkflowInstructionResponseSchema,
  SimpleOkResponseSchema,
  WorkflowSaveResponseSchema,
  WorkflowTransitionResponseSchema,
  WorkflowResetResponseSchema,
  WorkflowSnapshotSchema,
  JourneyAiResponseSchema,
  AbortResponseSchema,
  GlobalConfigurationResponseSchema,
  RemoteMediaResolveBodySchema,
  RemoteMediaResolveResponseSchema,
  type SseEvent,
  type SessionSummary as SharedSessionSummary,
  type WorkflowId as SharedWorkflowId,
  type AgentRuntime as SharedAgentRuntime,
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
import { buildModernizationPlan, readModernizationArtifact, toModernizationPlanView } from './workflow/modernization.js';
import {
  buildArchitectureAssessmentPlan,
  readArchitectureAssessmentArtifact,
  toArchitectureAssessmentView,
} from './workflow/assessment.js';
import { config } from './config.js';
import { getAgentCatalog, invalidateAgentCatalog } from './agent/provider-catalog.js';
import { clearProviderFailure } from './agent/provider-health.js';
import { ScopeGateError } from './workflow/scope-gate.js';
import { ReportGateError } from './workflow/report-gate.js';
import { getCachedRemoteMedia, resolveAndCacheRemoteMedia } from './media/remote-media.js';
function formatUserFacingError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const turnLimit = /Max turns \\(\\d+\\) exceeded/i.exec(raw);
  if (turnLimit) {
    return '这次调查在完成前已经连续执行了 ' + turnLimit[1] + ' 个步骤，达到了单轮执行上限。请再次提交问题继续调查。';
  }
  if (raw === 'Turn aborted.') return '这次调查已停止。';
  if (/waiting for user input/i.test(raw) && /Timeout after/i.test(raw)) return '等待你的回答时间过长，这次操作已停止。请重新回答。';
  if (/waiting for permission/i.test(raw) && /Timeout after/i.test(raw)) return '等待你确认操作时间过长，这次操作已停止。请重新提交。';
  if (/waiting for agent execution/i.test(raw) && /Timeout after/i.test(raw)) return '这次调查执行时间过长，已经停止。请重新开始，必要时缩小问题范围。';
  if (/waiting for .*session.*completion/i.test(raw) && /Timeout after/i.test(raw)) return '运行服务长时间没有返回结果，已经停止。请重试。';
  const openCodeHttp = /OpenCode[^\n]*HTTP\s+(\d+)/i.exec(raw);
  if (openCodeHttp) return 'OpenCode 当前无法连接（HTTP ' + openCodeHttp[1] + '）。请确认 OpenCode 服务已经启动，并检查服务地址。';
  if (/CodeBuddy SDK 没有返回文本答案/.test(raw)) return '助手这次没有返回可用结果。请重试；如果连续发生，请查看执行轨迹。';
  if (/OpenCode CLI 没有返回文本答案/.test(raw)) return 'OpenCode 这次没有返回可用结果。请查看执行轨迹中的最后一条错误，然后重试。';
  if (/OpenCode 运行时没有启用/.test(raw)) return 'OpenCode 当前没有启用。请在服务端设置 OPENCODE_ENABLED=true 后重试。';
  return raw.replace(new RegExp('^' + "AI "), '助手 ').replace(/^Agent /, '助手 ').replace(/^当前 Workflow/, '当前工作方式').replace(/^Workflow /, '工作方式').replace(/^CodeBuddy SDK /, '助手 ');
}


import {
  buildMissionDraft,
  evaluateMissionGate,
  formatMissionGateFailure,
  inferMissionDeliverables,
  MissionGateError,
} from './workflow/mission-gate.js';
import { buildMissionProgress } from './workflow/mission-progress.js';
import { closeLocalAnalytics, discoverLocalDatasets, listLocalDatasets, registerLocalDataset } from './analytics/local-data.js';
import {
  appendContextInput,
  appendTranscript,
  ensureWorkspace,
  loadWorkspaceContext,
  normalizeInvestigationName,
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
  getRunningConversationTurn,
  saveConversationMessage,
  updateConversationTurnDraft,
  searchConversation,
} from './investigation/conversation.js';
import {
  abortCopilotTurn,
  getClient,
  listPendingCopilotPermissions,
  respondToCopilotPermission,
  stopClient,
} from './agent/copilot.js';
import { listOpenCodeModels, abortOpenCodeTurn } from './agent/opencode.js';
import { listPendingAgentUserInputs, respondToAgentUserInput } from './agent/user-input-bridge.js';
import {
  appendAuditEvent,
  AuditDataError,
  loadInvestigationControl,
  loadGlobalConfiguration,
  readAuditEvents,
  updateGlobalConfiguration,
  updateInvestigationControl
} from './investigation/control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');
const webDist = path.join(webRoot, 'dist');

/** Session 列表给 UI 使用的轻量摘要，避免每次列表请求都返回完整 Investigation。 */
type SessionSummary = SharedSessionSummary;

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
  try {
    return normalizeInvestigationName(name);
  } catch {
    throw new RequestValidationError([{
      code: 'custom',
      path: ['name'],
      message: '调查名称只能使用单层目录名。',
    }]);
  }
}

/** Session API 的明确 Context Projection；不把 WorkspaceContext persistence schema 暴露给 Web。 */
function toSessionContextView(context: Awaited<ReturnType<typeof loadWorkspaceContext>>) {
  return {
    name: context.name,
    ...(context.mission ? { mission: context.mission } : {}),
    workflow: context.workflow,
    userPrompt: context.userPrompt,
    goal: context.goal,
    scope: context.scope,
    systems: context.systems,
    evidence: context.evidence,
    findings: context.findings,
    unknowns: context.unknowns,
    claims: context.claims,
    inputs: context.inputs,
    ...(context.journeyPlan ? { journeyPlan: context.journeyPlan } : {}),
    updatedAt: context.updatedAt,
  };
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
      if (context.name !== entry.name) {
        console.warn('[sessions] Workspace directory and context name differ; skipping the invalid session directory.', {
          directory: entry.name,
          contextName: context.name,
        });
        continue;
      }
      const conversation = getConversationSummary(entry.name);
      result.push({
        key: entry.name,
        label: context.mission?.purpose?.trim().slice(0, 60)
          || context.userPrompt?.trim().slice(0, 60)
          || entry.name,
        userPrompt: context.userPrompt ?? '',
        updatedAt: conversation.lastMessageAt ?? context.updatedAt,
      });
    } catch (error) {
      console.error('读取 Session 列表中的目录失败：', entry.name, error);
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 创建新的 Investigation、默认 Control 和初始审计事件；已存在时直接返回。 */
async function createSession(
  name?: string,
  userPrompt?: string,
  workflow?: SharedWorkflowId | null,
  runtime?: SharedAgentRuntime,
) {
  const key = sessionKey(
    name?.trim() ||
      'session-' +
        new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
  );
  if (await investigationExists(key)) {
    return loadWorkspaceContext(key);
  }
  const catalog = await getAgentCatalog();
  const requestedProvider = runtime
    ? catalog.providers.find((provider) => provider.runtime === runtime)
    : undefined;
  const selectedRuntime = requestedProvider?.usable
    ? runtime!
    : catalog.recommendedRuntime;
  const selectedProvider = catalog.providers.find((provider) => provider.runtime === selectedRuntime);
  if (!selectedProvider?.usable) {
    const failures = catalog.providers.map((provider) => provider.label + ': ' + provider.message).join('；');
    throw new Error('当前没有可用的 Agent Runtime。请检查 provider 配置后重试。' + (failures ? ' ' + failures : ''));
  }
  if (runtime && runtime !== selectedRuntime) {
    console.warn('[sessions] Requested Runtime is known to be unavailable; using the recommended available Runtime instead.', {
      sessionName: key,
      requestedRuntime: runtime,
      selectedRuntime,
      reason: requestedProvider?.message ?? selectedProvider.message,
    });
  }

  const investigation = newInvestigation(key, userPrompt?.trim() ?? '', workflow ?? null);
  await saveInvestigation(investigation);

  // Keep the user's Global preference separate from runtime availability. A new task
  // stores the effective usable choice; an unavailable preference is never copied blindly.
  const currentControl = await loadInvestigationControl(key);
  const selectedModel = selectedRuntime === 'codebuddy-sdk'
    ? catalog.models.find((model) => model.id === 'codebuddy:' + config.codeBuddyDefaultModel)?.id
      ?? catalog.models.find((model) => model.runtime === 'codebuddy')?.id
      ?? config.codeBuddyDefaultModel
    : selectedRuntime === 'opencode-run'
      ? (() => {
          const configured = config.openCodeFallbackModel
            ? (config.openCodeFallbackModel.startsWith('opencode:')
              ? config.openCodeFallbackModel
              : 'opencode:' + config.openCodeFallbackModel)
            : undefined;
          return (configured && catalog.models.some((model) => model.id === configured) ? configured : undefined)
            ?? catalog.models.find((model) => model.runtime === 'opencode')?.id
            ?? config.model;
        })()
      : catalog.models.find((model) => model.id === config.model && model.runtime === 'copilot')?.id
        ?? catalog.models.find((model) => model.runtime === 'copilot')?.id
        ?? config.model;

  if (runtime || selectedRuntime !== currentControl.agent.runtime) {
    await updateInvestigationControl(
      key,
      {
        research: currentControl.research,
        agent: {
          ...currentControl.agent,
          runtime: selectedRuntime,
          model: selectedModel,
        },
      },
      runtime === selectedRuntime ? 'initial Agent Runtime selection' : 'initial selection of available Agent Runtime',
    );
  }

  await appendAuditEvent(key, {
    actor: 'user',
    action: 'investigation.created',
    summary: 'Created investigation session.',
    details: {
      hasInitialPrompt: Boolean(userPrompt?.trim()),
      requestedRuntime: runtime ?? catalog.configuredDefaultRuntime,
      runtime: selectedRuntime,
      providerState: selectedProvider.state,
    },
  });
  console.info('[sessions] Investigation created.', {
    sessionName: key,
    requestedRuntime: runtime ?? catalog.configuredDefaultRuntime,
    selectedRuntime,
    providerState: selectedProvider.state,
    workflow: workflow ?? null,
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
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = typeof req.headers['x-request-id'] === 'string'
      ? req.headers['x-request-id']
      : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const details = {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
      };
      if (res.statusCode >= 500) {
        console.error('[http] Request failed.', details);
      } else if (res.statusCode >= 400) {
        console.warn('[http] Request rejected.', details);
      } else if (
        req.method !== 'GET'
        || req.path === '/api/agent/catalog'
        || req.path === '/api/config/global'
        || req.path === '/api/sessions'
        || req.path.endsWith('/messages/stream')
      ) {
        console.info('[http] Request completed.', details);
      } else if (durationMs >= 2_000) {
        console.warn('[http] Slow request.', details);
      }
    });
    next();
  });

  // 健康检查：只验证 Web service 能正常响应，不触发模型或数据库连接。
app.get('/api/health', (_req, res) => {
    res.json(HealthResponseSchema.parse({ ok: true, service: 'agentic-data-architect' }));
  });

  /** 返回工作台级 Global Agent 配置；与任何 Investigation 无关。 */
  app.get('/api/config/global', async (_req, res) => {
    res.json(GlobalConfigurationResponseSchema.parse({ configuration: await loadGlobalConfiguration() }));
  });

  /** 更新工作台级 Global Agent 默认配置；Task Override 不会被强制修改。 */
  app.put('/api/config/global', async (req, res) => {
    const body = parseRequest(UpdateGlobalConfigBodySchema, req.body);
    const configuration = await updateGlobalConfiguration(body.agent);
    invalidateAgentCatalog();
    console.info('[agent-config] Global Agent preference updated.', {
      version: configuration.version,
      preferredRuntime: configuration.agent.runtime,
      fallbackOrder: config.agentRuntimeFallbackOrder,
    });
    res.json(GlobalConfigurationResponseSchema.parse({ configuration }));
  });

  /** 解析远程图片/视频并预热 Global Cache。 */
  app.post('/api/global/media/resolve', async (req, res) => {
    const body = parseRequest(RemoteMediaResolveBodySchema, req.body);
    const result = await resolveAndCacheRemoteMedia(body.url, body.kind);
    const cached = await getCachedRemoteMedia(result.cacheKey);
    res.json(RemoteMediaResolveResponseSchema.parse({
      source: result.source,
      kind: result.kind,
      ...(result.remoteUrl ? { remoteUrl: result.remoteUrl } : {}),
      cacheKey: result.cacheKey,
      ...(cached ? { cacheUrl: '/api/global/media/' + result.cacheKey, cached: true } : { cached: false }),
      ...(result.mimeType ? { mimeType: result.mimeType } : {}),
    }));
  });

  /** 服务 Global Cache 中的远程媒体；视频支持 Range。 */
  app.get('/api/global/media/:cacheKey', async (req, res) => {
    const cacheKey = String(req.params.cacheKey);
    if (!/^[a-f0-9]{64}$/i.test(cacheKey)) {
      res.status(400).end();
      return;
    }
    const cached = await getCachedRemoteMedia(cacheKey);
    if (!cached) {
      res.status(404).end();
      return;
    }

    const mimeType = cached.mimeType;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (mimeType) res.setHeader('Content-Type', mimeType);

    if (typeof range === 'string') {
      const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : Math.max(0, cached.sizeBytes - Number(match[2] || 0));
        const end = match[2] ? Number(match[2]) : cached.sizeBytes - 1;
        if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < cached.sizeBytes) {
          res.status(206);
          res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + cached.sizeBytes);
          res.setHeader('Content-Length', String(end - start + 1));
          fsSync.createReadStream(cached.path, { start, end }).pipe(res);
          return;
        }
      }
      res.status(416).setHeader('Content-Range', 'bytes */' + cached.sizeBytes).end();
      return;
    }

    res.setHeader('Content-Length', String(cached.sizeBytes));
    fsSync.createReadStream(cached.path).pipe(res);
  });

  // Session 列表 API：返回 UI 左侧历史 Investigation。
app.get('/api/sessions', async (_req, res) => {
    res.json(SessionsResponseSchema.parse({ sessions: await listSessions() }));
  });

  // 创建 Session API：body 先经 Zod，再进入业务层。
app.post('/api/sessions', async (req, res) => {
    const body = parseRequest(CreateSessionBodySchema, req.body);
    const context = await createSession(body.name, body.userPrompt, body.workflow, body.runtime);
    res.status(201).json(CreateSessionResponseSchema.parse({ context: toSessionContextView(context) }));
  });

  app.get('/api/sessions/:name', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    const snapshot = await loadLatestSnapshot<any>(name);
    const conversation = getConversationSummary(name);
    const missionProgress = await buildMissionProgress(name, context.mission);
    const current = snapshot?.currentState;
    res.json(SessionDataSchema.parse({
      context: toSessionContextView(context),
      missionProgress,
      control: toControlView(await loadInvestigationControl(name)),
      localDatasets: listLocalDatasets(name),
      recentAudit: await readAuditEvents(name, 8),
      runningTurn: (() => {
        const turn = getRunningConversationTurn(name);
        return turn ? {
          turnId: turn.turnId,
          ...(turn.assistantDraft ? { assistantDraft: turn.assistantDraft } : {}),
          createdAt: turn.createdAt,
          updatedAt: turn.updatedAt,
        } : null;
      })(),
      messages: listConversationMessages(name, 1000).map((message) => ({
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
      res.status(409).json(ApiErrorSchema.parse({
        code: 'MISSION_CHANGE_BLOCKED',
        error: '本次调查正在执行，任务目标不能在执行中途修改。请先停止当前执行，再修改任务目的或期望结果。',
        details: { execution: activeTurn },
      }));
      return;
    }

    const body = parseRequest(UpdateMissionBodySchema, req.body);

    // “确认任务”是用户对任务边界的明确授权，不应该因为一次概率性的语言质量评分
    // 就把一个已经可以工作的任务挡在门外。真正的硬约束由 Mission Gate 负责：
    // 不能为空、不能是明显占位语句、必须能拆出至少一个交付物，而且交付物必须和文本一致。
    // 这样“希望调查当前项目的数据流 / 最后生成数据流图”这种自然表达可以直接开始，
    // 而“分析一下 / 给我一些建议”仍然会被确定性 Gate 拒绝。
    const draft = buildMissionDraft(body.purpose, body.expectedResult);
    if (!draft.purpose || !draft.expectedResult || draft.deliverableIds.length === 0) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'MISSION_INVALID',
        error: '请把任务目的和期望结果填写完整，并至少说明一种需要得到的结果。',
        details: { draft },
      }));
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

    res.json(MissionUpdateResponseSchema.parse({
      context: toSessionContextView(context),
      mission,
      gate: evaluateMissionGate(mission),
      progress: await buildMissionProgress(name, mission),
    }));
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
        error: formatUserFacingError(error),
      }));
    }
  });

  /** Canonical provider/model catalog shared by creation defaults and all Runtime consumers. */
  app.get('/api/agent/catalog', async (req, res) => {
    res.json(AgentCatalogResponseSchema.parse(
      await getAgentCatalog({ force: req.query.refresh === '1' }),
    ));
  });

  /** Clear a persisted unavailable marker only when the user explicitly asks to retry that provider. */
  app.post('/api/agent/providers/:runtime/retry', async (req, res) => {
    const parsedRuntime = AgentRuntimeSchema.safeParse(req.params.runtime);
    if (!parsedRuntime.success) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'VALIDATION_ERROR',
        error: '不认识这个 Agent Runtime。',
      }));
      return;
    }
    const runtime = parsedRuntime.data;
    await clearProviderFailure(runtime);
    invalidateAgentCatalog();
    const catalog = await getAgentCatalog({ force: true });
    console.warn('[agent-providers] User requested a provider retry; cleared its saved failure marker.', {
      runtime,
      stateAfterRetry: catalog.providers.find((provider) => provider.runtime === runtime)?.state,
    });
    res.json(AgentCatalogResponseSchema.parse(catalog));
  });

  /** Backward-compatible model-only route; it delegates to the same canonical provider catalog. */
  app.get('/api/copilot/models', async (_req, res) => {
    const catalog = await getAgentCatalog();
    res.json(ModelsResponseSchema.parse({ models: catalog.models }));
  });

  app.get('/api/sessions/:name/execution', async (req, res) => {
    const name = sessionKey(req.params.name);
    const active = getActiveInvestigationTurn(name);
    if (!active) {
      res.json(ExecutionStatusSchema.parse({ state: 'idle', running: false, turnId: null, phase: null, pendingPermissionCount: 0, pendingUserInputCount: 0, startedAt: null, lastActivityAt: null, lastActivity: null }));
      return;
    }
    const pendingPermissions = listPendingCopilotPermissions(name);
    const pendingUserInputs = listPendingAgentUserInputs(name);
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
    let events: Awaited<ReturnType<typeof readTrajectory>> = [];
    let trajectoryError: string | undefined;
    try {
      events = await readTrajectory(name, {
        ...(turnId ? { turnId } : {}),
        limit: Number.isFinite(limit) ? limit : 1000,
      });
    } catch (error) {
      console.error('Failed to read trajectory for session ' + name, error);
      events = [];
      trajectoryError = '执行轨迹数据出现异常，秘书暂时无法完整展示这次执行过程。核心调查结果不会因此丢失，请继续当前调查；如果问题持续，请重新启动本次调查。';
    }
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
    res.json(TrajectoryResponseSchema.parse({
      events,
      summary,
      turns: normalizedTurns,
      conversationTurns,
      ...(trajectoryError ? { error: trajectoryError } : {}),
    }));
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
      res.status(404).json(ApiErrorSchema.parse({
        code: 'PERMISSION_NOT_FOUND',
        error: '这个权限请求已经处理、已结束，或不属于当前执行。',
      }));
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
    res.json(SimpleOkResponseSchema.parse({ ok: true }));
  });

  /** 返回当前 Investigation 的 Agent 待回答问题。 */
  app.get('/api/sessions/:name/user-inputs', async (req, res) => {
    const name = sessionKey(req.params.name);
    res.json(UserInputsResponseSchema.parse({ requests: listPendingAgentUserInputs(name) }));
  });

  /** 把用户回答交回 ask_user；Agent 会从等待的 Promise 继续执行。 */
  app.post('/api/sessions/:name/user-inputs/respond', async (req, res) => {
    const name = sessionKey(req.params.name);
    const body = parseRequest(UserInputResponseBodySchema, req.body);
    const pending = listPendingAgentUserInputs(name).find(
      (item) => item.turnId === body.turnId && item.requestId === body.requestId,
    );
    const handled = respondToAgentUserInput(name, body.turnId, body.requestId, body.answer, body.wasFreeform);
    if (!handled) {
      res.status(404).json(ApiErrorSchema.parse({
        code: 'USER_INPUT_NOT_FOUND',
        error: '这个用户输入请求已经处理、已结束，或答案不符合请求要求。',
      }));
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
    res.json(SimpleOkResponseSchema.parse({ ok: true }));
  });

  app.get('/api/sessions/:name/audit', async (req, res) => {
    const name = sessionKey(req.params.name);
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    try {
      res.json(AuditResponseSchema.parse({ events: await readAuditEvents(name, Number.isFinite(limit) ? limit : 100) }));
    } catch (error) {
      if (error instanceof AuditDataError) {
        res.status(500).json(ApiErrorSchema.parse({
          code: 'AUDIT_DATA_INVALID',
          error: formatUserFacingError(error),
        }));
        return;
      }
      throw error;
    }
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
    res.json(WorkflowContextResponseSchema.parse({ context: toSessionContextView(context) }));
  });

  /** 返回当前 Workflow 给工作地图页面；页面打开后直接进入可编辑状态。 */
  app.get('/api/sessions/:name/workflow', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json(ApiErrorSchema.parse({
      code: 'WORKFLOW_REQUIRED',
      error: '这个调查还没有选择工作方式，先到调查设置选择一种工作方式。',
    }));
      return;
    }
    res.json(WorkflowSnapshotSchema.parse(await getJourneySnapshot(name, context.workflow)));
  });

  /** 保存工作地图；服务端先做完整结构检查，通过后才创建新版本。 */
  app.put('/api/sessions/:name/workflow', async (req, res) => {
    const name = sessionKey(req.params.name);
    // Workflow Definition/Execution 是同一状态机的控制面；Agent 正在跑时允许保存新图，
    // 会让正在执行的旧 turn 与新 version 同时存在，旧结果还有可能写回新图。
    // 因此这里像 Mission 修改一样，在入口直接阻止并发变更。
    const activeTurn = getActiveInvestigationTurn(name);
    if (activeTurn) {
      res.status(409).json(ApiErrorSchema.parse({
        code: 'WORKFLOW_CHANGE_BLOCKED',
        error: '本次调查正在执行，工作方式暂时不能修改。请先停止当前执行，再保存新的工作地图。',
        details: { execution: activeTurn },
      }));
      return;
    }

    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json(ApiErrorSchema.parse({
      code: 'WORKFLOW_REQUIRED',
      error: '这个调查还没有选择工作方式，先到调查设置选择一种工作方式。',
    }));
      return;
    }

    const body = parseRequest(JourneyEditBodySchema, req.body);
    const validation = validateJourneyEdit(body.definition, body.layout);
    if (validation.issues.length) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'WORKFLOW_VALIDATION_FAILED',
        error: '工作地图还不能保存，请先修正这些问题。',
        details: { issues: validation.issues },
      }));
      return;
    }

    const result = await saveJourneyDefinition(
      name,
      context.workflow,
      body.definition,
      body.layout,
    );
    res.json(WorkflowSaveResponseSchema.parse(result));
  });

  /** 工作地图专用 AI：只生成/修改 Workflow，不参与数据分析。 */
  app.post('/api/sessions/:name/workflow/ai', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json(ApiErrorSchema.parse({
      code: 'WORKFLOW_REQUIRED',
      error: '这个调查还没有选择工作方式，先到调查设置选择一种工作方式。',
    }));
      return;
    }

    const body = parseRequest(JourneyAiRequestSchema, req.body);
    const currentDefinition = body.definition === undefined
      ? undefined
      : JourneyDefinitionSchema.parse(body.definition);

    if (currentDefinition && currentDefinition.id !== context.workflow) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'WORKFLOW_MISMATCH',
        error: '当前工作地图与所选 Workflow 不一致，请刷新后重试。',
      }));
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
    res.json(JourneyAiResponseSchema.parse(result));
  });

  /** 人工完成 waiting 节点；与 Agent transition 共用 Workflow version 检查。 */
  app.post('/api/sessions/:name/workflow/transition', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json(ApiErrorSchema.parse({
      code: 'WORKFLOW_REQUIRED',
      error: '这个调查还没有选择工作方式，无法推进 Workflow。',
    }));
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
      res.status(409).json(ApiErrorSchema.parse({
        code: 'WORKFLOW_TRANSITION_REJECTED',
        error: result.error || 'Workflow 没有推进。',
      }));
      return;
    }
    res.json(WorkflowTransitionResponseSchema.parse(result));
  });

  /** 删除当前 Investigation 的自定义地图，恢复所选工作方式的内置路线。 */
  app.post('/api/sessions/:name/workflow/reset', async (req, res) => {
    const name = sessionKey(req.params.name);
    const activeTurn = getActiveInvestigationTurn(name);
    if (activeTurn) {
      res.status(409).json(ApiErrorSchema.parse({
        code: 'WORKFLOW_CHANGE_BLOCKED',
        error: '本次调查正在执行，工作地图不能重置。请先停止当前执行，再重置工作地图。',
        details: { execution: activeTurn },
      }));
      return;
    }

    const context = await loadWorkspaceContext(name);
    if (!context.workflow) {
      res.status(409).json(ApiErrorSchema.parse({
      code: 'WORKFLOW_REQUIRED',
      error: '这个调查还没有选择工作方式，无法恢复工作地图。',
    }));
      return;
    }
    res.json(WorkflowResetResponseSchema.parse(await resetJourneyCustomization(name, context.workflow)));
  });


  /** 主对话框切换模型 / Auto 选择方式；保存后从下一轮对话开始使用。 */
  app.patch('/api/sessions/:name/agent/model', async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    const body = parseRequest(UpdateAgentModelBodySchema, req.body);
    const current = await loadInvestigationControl(name);
    if (body.model !== 'auto' && body.autoTier) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'AUTO_TIER_INVALID',
        error: '只有选择 Auto 时才能设置自动选择方式。',
      }));
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
    res.json(ControlResponseSchema.parse({ control: toControlView(control) }));
  });

  app.put('/api/sessions/:name/config', async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    const body = parseRequest(UpdateConfigBodySchema, req.body);
    const control = await updateInvestigationControl(name, {
      research: body.research,
      agent: body.agent,
    });
    res.json(ControlResponseSchema.parse({ control: toControlView(control) }));
  });

  // 文件上传 API：把文件存入当前 Investigation workspace，并记录 sha256/Evidence 输入。
app.post('/api/sessions/:name/files', upload.single('file'), async (req, res) => {
    const name = sessionKey(String(req.params.name));
    if (!req.file) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'FILE_REQUIRED',
        error: '没有收到文件，请重新选择要上传的文件。',
      }));
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
    } catch (error) {
      const extension = path.extname(req.file.originalname).toLowerCase();
      const analyticalExtensions = new Set(['.csv', '.json', '.jsonl', '.ndjson', '.parquet', '.xlsx']);
      if (analyticalExtensions.has(extension)) {
        throw new Error(
          '这个数据文件已经上传，但系统没能把它登记为可分析的数据集。'
          + ' 请检查文件内容后重新上传。'
          + '（' + (error instanceof Error ? error.message : String(error)) + '）',
        );
      }
      // 其它普通文件继续作为文档保存。
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

    res.status(201).json(FileUploadResponseSchema.parse({
      input,
      file: {
        id: input.id,
        name: req.file.originalname,
        path: relativePath,
        size: req.file.size,
        mimeType: req.file.mimetype || 'application/octet-stream',
        ...(dataset ? { dataset } : {}),
      },
    }));
  });

  /** 上传当前 Investigation 的秘书头像；头像只属于当前任务，不再写入共享默认目录。 */
  app.post('/api/sessions/:name/assistant/avatar', upload.single('file'), async (req, res) => {
    const name = sessionKey(routeParam(req.params.name));
    if (!req.file) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'AVATAR_REQUIRED',
        error: '没有收到头像文件，请重新选择。',
      }));
      return;
    }
    const allowedAvatarTypes = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime',
    ]);
    if (!allowedAvatarTypes.has(req.file.mimetype)) {
      res.status(400).json(ApiErrorSchema.parse({
        code: 'AVATAR_TYPE_UNSUPPORTED',
        error: '头像只支持 PNG、JPEG、WebP、GIF、MP4、WebM 或 MOV。',
      }));
      return;
    }
    if (req.file.size > 10 * 1024 * 1024) {
      res.status(413).json(ApiErrorSchema.parse({
        code: 'AVATAR_TOO_LARGE',
        error: '头像文件过大，请重新裁剪后上传。',
      }));
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

    res.json(ControlResponseSchema.parse({ control: toControlView(control) }));
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
      const root = path.resolve(workspaceRoot(name));
      const target = path.resolve(root, relativePath);
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (target !== root && !target.startsWith(rootWithSep)) {
        res.status(404).end();
        return;
      }
      const buffer = await fs.readFile(target);
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

  /** 给调试/测试和普通 Agent 路径使用的当前 Workflow 控制摘要。 */
  app.get('/api/sessions/:name/workflow/instruction', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    res.type('text/plain').send(
      WorkflowInstructionResponseSchema.parse(await buildJourneyAgentInstruction(name, context.workflow)),
    );
  });

  app.get('/api/sessions/:name/assessment', async (req, res) => {
    const name = sessionKey(req.params.name);
    const context = await loadWorkspaceContext(name);
    if (context.workflow !== 'data-architecture-assessment') {
      res.json(ArchitectureAssessmentResponseSchema.parse({
        status: 'blocked',
        plan: null,
        path: null,
      }));
      return;
    }
    const result = await readArchitectureAssessmentArtifact(name);
    res.json(ArchitectureAssessmentResponseSchema.parse({
      status: result.status,
      plan: result.plan ? toArchitectureAssessmentView(result.plan) : null,
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
        status: 'current',
        plan: toArchitectureAssessmentView(result.plan),
        path: result.path,
      }));
    } catch (error) {
      if (error instanceof ScopeGateError || error instanceof MissionGateError) {
        res.status(409).json(ApiErrorSchema.parse({
          code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : 'SCOPE_REQUIRED',
          error: formatUserFacingError(error),
          details: { checks: error.result.checks },
        }));
        return;
      }
      throw error;
    }
  });

  app.get('/api/sessions/:name/modernization', async (req, res) => {
    const name = sessionKey(req.params.name);
    const result = await readModernizationArtifact(name);
    res.json(ModernizationResponseSchema.parse({
      status: result.status,
      plan: result.plan ? toModernizationPlanView(result.plan) : null,
      path: null,
    }));
  });

  app.post('/api/sessions/:name/modernization/regenerate', async (req, res) => {
    const name = sessionKey(req.params.name);
    try {
      const result = await buildModernizationPlan(name);
      res.json(ModernizationResponseSchema.parse({
        status: 'current',
        plan: toModernizationPlanView(result.plan),
        path: result.path,
      }));
    } catch (error) {
      if (error instanceof ScopeGateError || error instanceof MissionGateError) {
        res.status(409).json(ApiErrorSchema.parse({
          code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : 'SCOPE_REQUIRED',
          error: formatUserFacingError(error),
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
    res.json(ReportArtifactStateSchema.parse(report));
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
        res.status(409).json(ApiErrorSchema.parse({
          code: error instanceof MissionGateError ? 'MISSION_REQUIRED' : error instanceof ReportGateError ? 'REPORT_PRECONDITION_FAILED' : 'SCOPE_REQUIRED',
          error: formatUserFacingError(error),
          details: { checks: error.result.checks },
        }));
        return;
      }
      if (error instanceof ReportQualityGateError) {
        res.status(409).json(ApiErrorSchema.parse({
          code: error.review.availability === 'unavailable' ? 'REPORT_REVIEW_UNAVAILABLE' : 'REPORT_REVIEW_FAILED',
          error: formatUserFacingError(error),
        }));
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
        res.json(SharedIndexSchema.parse({ schemaVersion: 1, artifacts: [], updatedAt: new Date().toISOString() }));
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
      res.status(409).json(ApiErrorSchema.parse({
      code: 'ROUTE_PLAN_STALE',
      error: '这个下一步已经过期，请根据最新情况重新选择。',
    }));
      return;
    }

    const missionGate = evaluateMissionGate(context.mission);
    if (!missionGate.passed) {
      const blockedTurnId = body.turnId ?? randomUUID();
      await preserveBlockedUserMessage(name, blockedTurnId, message);
      res.status(409).json(ApiErrorSchema.parse({
        code: 'MISSION_REQUIRED',
        error: formatMissionGateFailure(missionGate),
        details: {
          draft: buildMissionDraft(context.goal || context.userPrompt),
          turnId: blockedTurnId,
        },
      }));
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
    res.json(AnswerSummarySchema.parse(result));
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
      res.status(409).json(ApiErrorSchema.parse({
      code: 'ROUTE_PLAN_STALE',
      error: '这个下一步已经过期，请根据最新情况重新选择。',
    }));
      return;
    }
    const message = body.message
      ?? (selectedRoute ? '选择下一步：' + selectedRoute.title : '');

    const missionGate = evaluateMissionGate(context.mission);
    if (!missionGate.passed) {
      const blockedTurnId = body.turnId ?? randomUUID();
      await preserveBlockedUserMessage(name, blockedTurnId, message);
      res.status(409).json(ApiErrorSchema.parse({
        code: 'MISSION_REQUIRED',
        error: formatMissionGateFailure(missionGate),
        details: {
          draft: buildMissionDraft(context.goal || context.userPrompt),
          turnId: blockedTurnId,
        },
      }));
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
    // If execution fails, the catch path persists whatever the secretary already showed.
    let finished = false;
    let streamedAssistant = '';
    let companionNote = '';
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
        (delta) => {
          streamedAssistant += delta;
          try {
            updateConversationTurnDraft(
              turnId,
              [companionNote.trim(), streamedAssistant.trim()].filter(Boolean).join('\n\n'),
            );
          } catch (draftError) {
            console.error('[messages/stream] Failed to persist assistant draft', {
              sessionName: name,
              turnId,
              error: draftError,
            });
          }
          send('delta', { delta });
        },
        turnId,
        (status) => send('status', { status }),
        {
          ...(selectedRoute ? { selectedRoute } : {}),
          ...(body.guided && !selectedRoute ? { selectedGuidance: message } : {}),
          onReasoningDelta: (delta) => send('reasoning', { delta }),
          onCheckpoint: (checkpoint) => send('checkpoint', checkpoint),
          onCompanionNote: (note) => {
            companionNote = note;
            try {
              updateConversationTurnDraft(
                turnId,
                [companionNote.trim(), streamedAssistant.trim()].filter(Boolean).join('\n\n'),
              );
            } catch (draftError) {
              console.error('[messages/stream] Failed to persist companion draft', {
                sessionName: name,
                turnId,
                error: draftError,
              });
            }
            send('companion_note', { note });
          },
        },
      );
      send('completed', result);
      finished = true;
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[messages/stream] Investigation execution failed', {
        sessionName: name,
        turnId,
        message,
        stack: error instanceof Error ? error.stack : undefined,
        error,
      });

      // answerQuestion 已经把失败 turn 和可见的部分内容保存成 durable assistant message。
      // SSE 这里只负责把失败通知给当前浏览器，避免和 conversation store 双写。
      send('error', { error: formatUserFacingError(error) });
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
      res.status(404).json(ApiErrorSchema.parse({
        code: 'TURN_NOT_FOUND',
        error: '找不到这次请求，请刷新页面后重试。',
      }));
      return;
    }
    const requested = requestAbort(name, turnId);
    const aborted = requested
      || await abortCopilotTurn(turnId)
      || await abortCodeBuddyTurn(turnId)
      || await abortOpenCodeTurn(turnId);
    res.json(AbortResponseSchema.parse({ aborted }));
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

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] Request handler failed.', {
      requestId: req.headers['x-request-id'],
      method: req.method,
      path: req.path,
      error,
      stack: error instanceof Error ? error.stack : undefined,
    });
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
        error: formatUserFacingError(error),
        details: { checks: error.result.checks },
      }));
      return;
    }
    res.status(500).json(ApiErrorSchema.parse({
      code: 'INTERNAL_ERROR',
      error: formatUserFacingError(error),
    }));
  });

  return app;
}
