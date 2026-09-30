import { askCopilot, hasActiveCopilotTurn } from '../agent/copilot.js';
import { buildQuestionPrompt, LEAD_SYSTEM_PROMPT } from '../agent/prompts.js';
import { parseAgentAnswer, toClaims } from '../agent/result.js';
import { buildQuestionContext } from '../analysis/context.js';
import { nextId } from '../evidence/types.js';
import { abortStaleConversationTurn, beginConversationTurn, finishConversationTurn, getRunningConversationTurn, saveConversationMessage, searchConversation } from '../investigation/conversation.js';
import {
  appendAuditEvent,
  buildResearchConfigPrompt,
  loadInvestigationControl,
  toCopilotMcpServers,
} from '../investigation/control.js';
import { loadInvestigation, loadLatestSnapshot, saveInvestigation } from '../investigation/store.js';
import { workspaceRoot } from '../investigation/workspace.js';
import type { DiscoverySnapshot } from './discover.js';

const activeInvestigationTurns = new Map<string, { turnId: string; phase: 'executing' | 'committing' }>();
const abortRequestedTurns = new Set<string>();

export function requestAbort(investigationName: string, turnId: string): boolean {
  const active = activeInvestigationTurns.get(investigationName);
  if (!active || active.turnId !== turnId || active.phase !== 'executing') return false;
  abortRequestedTurns.add(turnId);
  return true;
}

export interface AnswerSummary {
  answer: string;
  claimIds: string[];
  warnings: string[];
  unknowns: string[];
}

export async function answerQuestion(
  investigationName: string,
  question: string,
  onDelta?: (delta: string) => void,
  turnId?: string,
  onStatus?: (status: string) => void,
): Promise<AnswerSummary> {
  if (!turnId) turnId = nextId('turn');

  const reservedTurn = activeInvestigationTurns.get(investigationName);
  if (reservedTurn && reservedTurn.turnId !== turnId) {
    throw new Error('This investigation already has an active turn.');
  }

  let turn;
  try {
    turn = beginConversationTurn(investigationName, turnId);
  } catch (error) {
    const running = getRunningConversationTurn(investigationName);
    if (running) throw new Error('This investigation already has an active turn.');
    throw error;
  }

  if (turn.status === 'completed' && turn.result) return JSON.parse(turn.result) as AnswerSummary;

  if (turn.status === 'running') {
    const sameTurnActive =
      activeInvestigationTurns.get(investigationName)?.turnId === turn.turnId ||
      hasActiveCopilotTurn(turn.turnId);
    if (sameTurnActive) {
      throw new Error('This investigation already has an active turn.');
    }
    abortStaleConversationTurn(turn.turnId);
  }

  if (turn.status === 'failed' || turn.status === 'aborted') {
    throw new Error('This turn ID has already finished and cannot be retried.');
  }

  // Reserve before the first await so another request cannot mistake this turn
  // for stale work while the Copilot session is still being created.
  activeInvestigationTurns.set(investigationName, { turnId, phase: 'executing' });
  try {
    if (abortRequestedTurns.has(turnId)) throw new Error('Turn aborted.');

    const userMessage = saveConversationMessage({
    id: turnId + ':user',
    sessionName: investigationName,
    role: 'user',
    content: question,
  });
  const inv = await loadInvestigation(investigationName);
  const control = await loadInvestigationControl(investigationName);
  await appendAuditEvent(investigationName, {
    actor: 'user',
    action: 'investigation.question',
    summary: 'Asked investigation question.',
    configurationVersion: control.version,
    details: { questionLength: question.length },
  });

  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(investigationName);
  const ctx = buildQuestionContext({
    question,
    lineage: snapshot?.lineage ?? null,
    profiles: snapshot?.profiles ?? [],
    findings: inv.findings,
    evidence: inv.evidence,
  });
  const priorConversation = searchConversation(investigationName, question, {
    limit: 6,
    beforeRowId: userMessage.rowId,
  });
  const conversationText = priorConversation.length > 0
    ? [
        '## Relevant conversation history',
        'The following earlier messages were retrieved by full-text search. Treat them as conversation context, not as evidence; current evidence and verified findings take precedence.',
        '',
        ...priorConversation.slice().reverse().map((item) => {
          const excerpt = item.content.length > 1200 ? item.content.slice(0, 1200) + '…' : item.content;
          return `[${item.role}] ${excerpt}`;
        }),
      ].join('\n')
    : '';
  const questionContextText = [ctx.text, conversationText].filter(Boolean).join('\n\n');

  const existingIds = new Set(inv.evidence.map((e) => e.id));
  const prompt = buildQuestionPrompt({
    investigationName: inv.name,
    goal: inv.goal,
    scope: inv.scope,
    question,
    contextText: questionContextText,
    evidenceIds: ctx.evidenceIds,
    unknowns: inv.unknowns,
  });
    // The prompt and configuration snapshot are fixed for this turn; later
    // UI changes apply only to the next turn.
    const raw = await askCopilot({
    prompt,
    systemPrompt: [
      LEAD_SYSTEM_PROMPT,
      buildResearchConfigPrompt(control),
      control.agent.systemPrompt.content.trim(),
    ].filter(Boolean).join('\n\n'),
    ...(inv.copilotConfigurationVersion === control.version && inv.copilotSessionId
      ? { sessionId: inv.copilotSessionId }
      : {}),
    onSessionId: (sessionId) => {
      if (sessionId !== inv.copilotSessionId) {
        inv.copilotSessionId = sessionId;
      }
      inv.copilotConfigurationVersion = control.version;
    },
    workingDirectory: workspaceRoot(inv.name),
    skills: control.agent.skills.map((item) => item.name),
    mcpServers: toCopilotMcpServers(control) as NonNullable<Parameters<typeof askCopilot>[0]['mcpServers']>,
    ...(onDelta ? { onDelta } : {}),
    ...(onStatus ? { onStatus } : {}),
    turnId,
    shouldAbort: () => abortRequestedTurns.has(turnId),
  });
  if (abortRequestedTurns.has(turnId)) throw new Error('Turn aborted.');

  // Once the model has returned, move into a non-cancelable commit phase.
  // This prevents a Stop request from leaving context state and conversation
  // history half-committed.
  const activeAfterExecution = activeInvestigationTurns.get(investigationName);
  if (activeAfterExecution?.turnId === turnId) {
    activeAfterExecution.phase = 'committing';
  }
  abortRequestedTurns.delete(turnId);

  const parsed = parseAgentAnswer(raw, existingIds);
  const claims = toClaims(parsed, () => nextId('c'));
  inv.claims.push(...claims);
  if (!inv.questions.includes(question)) inv.questions.push(question);
  for (const u of parsed.unknowns) {
    if (!inv.unknowns.includes(u)) inv.unknowns.push(u);
  }

  const answer = parsed.answer || raw.slice(0, 2000);
  await saveInvestigation(inv);
  saveConversationMessage({
    sessionName: investigationName,
    role: 'assistant',
    content: answer,
  });
  const result: AnswerSummary = {
    answer,
    claimIds: claims.map((c) => `${c.id}[${c.status}]`),
    warnings: parsed.warnings,
    unknowns: parsed.unknowns,
  };
  finishConversationTurn(turnId, 'completed', JSON.stringify(result));
  return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishConversationTurn(turnId, /abort/i.test(message) ? 'aborted' : 'failed', undefined, message);
    throw error;
  } finally {
    if (activeInvestigationTurns.get(investigationName)?.turnId === turnId) {
      activeInvestigationTurns.delete(investigationName);
    }
    abortRequestedTurns.delete(turnId);
  }
}
