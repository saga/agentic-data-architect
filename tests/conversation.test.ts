import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  getConversationSummary,
  listConversationMessages,
  migrateLegacyConversationInputs,
  saveConversationMessage,
  searchConversation,
} from '../src/investigation/conversation.js';

test('stores conversation turns in sqlite and searches them with fts5', () => {
  const sessionName = 'conversation-test-' + randomUUID();

  const user = saveConversationMessage({
    sessionName,
    role: 'user',
    content: 'Where does Position come from in the legacy platform?',
  });
  saveConversationMessage({
    sessionName,
    role: 'assistant',
    content: 'Position is sourced from IBOR and reconciled against the Security Master.',
  });

  const messages = listConversationMessages(sessionName);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.id, user.id);
  assert.equal(messages[1]?.role, 'assistant');

  const hits = searchConversation(sessionName, 'Security Master');
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.content ?? '', /Security Master/);

  const summary = getConversationSummary(sessionName);
  assert.equal(summary.count, 2);
  assert.ok(summary.lastMessageAt);
});

test('migrates legacy chat inputs out of workspace state', () => {
  const sessionName = 'conversation-migration-test-' + randomUUID();
  const inputs = [
    {
      id: 'legacy-user-message-' + randomUUID(),
      kind: 'user_message',
      capturedAt: '2026-09-30T09:59:59.000Z',
      title: 'Legacy user message',
      content: 'Please trace the Position source.',
    },
    {
      id: 'legacy-question-' + randomUUID(),
      kind: 'question',
      capturedAt: '2026-09-30T10:00:00.000Z',
      title: 'Legacy question',
      content: 'What is the canonical Price source?',
    },
    {
      id: 'legacy-answer-' + randomUUID(),
      kind: 'assistant_message',
      capturedAt: '2026-09-30T10:00:01.000Z',
      title: 'Legacy answer',
      content: 'The canonical Price source is the approved market data feed.',
    },
    {
      id: 'keep-note-' + randomUUID(),
      kind: 'note',
      capturedAt: '2026-09-30T10:00:02.000Z',
      title: 'Keep note',
      content: 'This stays in context.json.',
    },
  ];

  const remaining = migrateLegacyConversationInputs(sessionName, inputs);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.kind, 'note');

  const messages = listConversationMessages(sessionName);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[1]?.role, 'user');
  assert.equal(messages[2]?.role, 'assistant');
});
