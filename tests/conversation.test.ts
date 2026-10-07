import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  abortStaleConversationTurn,
  beginConversationTurn,
  getConversationTurn,
  getConversationSummary,
  recoverRunningConversationTurns,
  updateConversationTurnDraft,
  getRunningConversationTurn,
  listConversationMessages,
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

  saveConversationMessage({
    sessionName,
    role: 'assistant',
    content: 'Position 的权威来源是 IBOR，Security Master 负责证券标识映射。',
  });
  const chineseHits = searchConversation(sessionName, '权威来源');
  assert.equal(chineseHits.length, 1);
  assert.match(chineseHits[0]?.content ?? '', /权威来源/);

  const summary = getConversationSummary(sessionName);
  assert.equal(summary.count, 3);
  assert.ok(summary.lastMessageAt);
});

test('allows stale running turns to be recovered before a new turn starts', () => {
  const sessionName = 'conversation-turn-test-' + randomUUID();
  const first = beginConversationTurn(sessionName, 'turn-' + randomUUID());

  assert.equal(first.status, 'running');
  assert.equal(getRunningConversationTurn(sessionName)?.turnId, first.turnId);
  assert.throws(
    () => beginConversationTurn(sessionName, 'turn-' + randomUUID()),
  );

  assert.equal(abortStaleConversationTurn(first.turnId), true);
  assert.equal(getRunningConversationTurn(sessionName), undefined);

  const second = beginConversationTurn(sessionName, 'turn-' + randomUUID());
  assert.equal(second.status, 'running');
  assert.equal(abortStaleConversationTurn(second.turnId), true);
});

test('server restart recovery preserves partial assistant draft', () => {
  const sessionName = 'conversation-recovery-test-' + randomUUID();
  const turnId = 'turn-' + randomUUID();
  beginConversationTurn(sessionName, turnId);
  saveConversationMessage({
    id: turnId + ':user',
    sessionName,
    role: 'user',
    content: '继续检查代码结构。',
  });
  updateConversationTurnDraft(turnId, '秘书：我已经找到一个关键入口。\\n\\n正在检查下游调用。');

  assert.match(getConversationTurn(turnId)?.assistantDraft ?? '', /关键入口/);
  assert.equal(recoverRunningConversationTurns(), 1);
  assert.equal(getConversationTurn(turnId)?.status, 'aborted');
  assert.equal(getConversationTurn(turnId)?.assistantDraft, undefined);

  const messages = listConversationMessages(sessionName);
  const failure = messages.find((message) => message.id === turnId + ':assistant:failure');
  assert.ok(failure);
  assert.match(failure?.content ?? '', /关键入口/);
  assert.match(failure?.content ?? '', /服务刚刚在调查过程中停止/);
});
