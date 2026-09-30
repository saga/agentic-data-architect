import fs from 'node:fs/promises';
import path from 'node:path';
import { askCopilot } from '../agent/copilot.js';
import { buildQuestionPrompt, LEAD_SYSTEM_PROMPT } from '../agent/prompts.js';
import { parseAgentAnswer, toClaims } from '../agent/result.js';
import { buildQuestionContext } from '../analysis/context.js';
import { nextId } from '../evidence/types.js';
import { saveConversationMessage, searchConversation } from '../investigation/conversation.js';
import { loadInvestigation, loadLatestSnapshot, saveInvestigation } from '../investigation/store.js';
import { workspaceRoot } from '../investigation/workspace.js';
import type { DiscoverySnapshot } from './discover.js';

export interface AnswerSummary {
  answer: string;
  claimIds: string[];
  warnings: string[];
  unknowns: string[];
}

async function loadInvestigationSkill(): Promise<string> {
  const file = path.resolve(process.cwd(), 'skills/investigation-session/SKILL.md');
  return fs.readFile(file, 'utf8');
}

export async function answerQuestion(
  investigationName: string,
  question: string,
  onDelta?: (delta: string) => void,
): Promise<AnswerSummary> {
  const userMessage = saveConversationMessage({
    sessionName: investigationName,
    role: 'user',
    content: question,
  });
  const inv = await loadInvestigation(investigationName);

  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(investigationName);
  const ctx = buildQuestionContext({
    question,
    lineage: snapshot?.lineage ?? null,
    profiles: snapshot?.profiles ?? [],
    findings: inv.findings,
    evidence: inv.evidence,
  });
  const priorConversation = searchConversation(investigationName, question, {
    limit: 8,
    beforeRowId: userMessage.rowId,
  });
  const conversationText = priorConversation.length > 0
    ? [
        '## Relevant conversation history',
        'The following earlier messages were retrieved by full-text search. Treat them as conversation context, not as evidence; current evidence and verified findings take precedence.',
        '',
        ...priorConversation.slice().reverse().map((item) =>
          `[${item.role}] ${item.content}`,
        ),
      ].join('\\n')
    : '';
  const questionContextText = [ctx.text, conversationText].filter(Boolean).join('\\n\\n');

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
  const skill = await loadInvestigationSkill();
  const raw = await askCopilot({
    prompt,
    systemPrompt: LEAD_SYSTEM_PROMPT + '\n\nINVESTIGATION SKILL:\n' + skill,
    workingDirectory: workspaceRoot(inv.name),
    ...(onDelta ? { onDelta } : {}),
  });
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

  return {
    answer,
    claimIds: claims.map((c) => `${c.id}[${c.status}]`),
    warnings: parsed.warnings,
    unknowns: parsed.unknowns,
  };
}
