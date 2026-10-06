/**
 * Conversation durable state、幂等和 SQLite FTS。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

/** 对话消息角色；与 Copilot/LLM 的常见角色保持简单一致。 */
function dbOrThrow(): Database.Database {
  if (!conversationDb) throw new Error('Conversation store is not initialized.');
  return conversationDb;
}

function extractSearchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/i).map((term) => term.trim()).filter((term) => term.length >= 2))];
}

export type ConversationRole = 'user' | 'assistant' | 'system';

/** 持久化后的单条对话消息。 */
export interface ConversationMessage {
  id: string;
  sessionName: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

/** 带全文检索相关性分数的对话命中。 */
export interface ConversationSearchHit extends ConversationMessage {
  score: number;
}

/** 一次用户问题的 durable turn 生命周期记录。 */
export interface ConversationTurn {
  turnId: string;
  sessionName: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 当前 Investigation 对话数量和最近消息时间的轻量摘要。 */
export interface ConversationSummary {
  count: number;
  lastMessageAt?: string;
}

interface MessageRow {
  message_id: string;
  session_name: string;
  role: ConversationRole;
  content: string;
  created_at: string;
  score?: number;
}

interface MessageWrite {
  id?: string;
  sessionName: string;
  role: ConversationRole;
  content: string;
  createdAt?: string;
}

let database: DatabaseSync | undefined;
let databasePath: string | undefined;

/** 返回整个应用共享的 SQLite conversation 数据库路径。 */
export function conversationDbFile(): string {
  return path.join(config.workspaceDir, 'conversations.db');
}

/** 初始化或复用 SQLite 数据库，创建 turn、message 和 FTS 表及约束。 */
function getDatabase(): DatabaseSync {
  const file = conversationDbFile();
  if (database && databasePath === file) return database;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  database?.close();

  database = new DatabaseSync(file);
  databasePath = file;
  database.exec(`
    -- WAL lets reads continue while a turn/message write is in progress.
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS conversation_turns (
      turn_id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_conversation_turns_session
      ON conversation_turns(session_name, updated_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_one_running
      ON conversation_turns(session_name)
      WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      session_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id
      ON conversation_messages(session_name, id);

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_created
      ON conversation_messages(session_name, created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
      content,
      content='conversation_messages',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS conversation_messages_ai
    AFTER INSERT ON conversation_messages
    BEGIN
      INSERT INTO conversation_messages_fts(rowid, content)
      VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS conversation_messages_ad
    AFTER DELETE ON conversation_messages
    BEGIN
      INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS conversation_messages_au
    AFTER UPDATE OF content ON conversation_messages
    BEGIN
      INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
      INSERT INTO conversation_messages_fts(rowid, content)
      VALUES (new.id, new.content);
    END;
  `);

  return database;
}

/** 把 SQLite message row 转成应用层 ConversationMessage。 */
function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.message_id,
    sessionName: row.session_name,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

// The partial unique index below makes "one running turn per investigation" a
// database invariant, not just a convention in the workflow code.
/** 创建一次 durable turn；借助唯一索引保证同一 Investigation 只能有一个 running turn。 */
export function beginConversationTurn(sessionName: string, turnId: string): ConversationTurn {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO conversation_turns (turn_id, session_name, status, created_at, updated_at)
    VALUES (?, ?, 'running', ?, ?)
    ON CONFLICT(turn_id) DO NOTHING
  `).run(turnId, sessionName, now, now);
  const row = db.prepare(`
    SELECT turn_id, session_name, status, result, error, created_at, updated_at
    FROM conversation_turns WHERE turn_id = ?
  `).get(turnId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Conversation turn could not be stored: ' + turnId);
  if (Number(result.changes) === 0 && row.session_name !== sessionName) {
    throw new Error('Turn ID is already used by another investigation');
  }
  return {
    turnId: String(row.turn_id),
    sessionName: String(row.session_name),
    status: row.status as ConversationTurn['status'],
    ...(typeof row.result === 'string' ? { result: row.result } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 把 running turn 结束为 completed/failed/aborted，并保存结果或错误。 */
export function finishConversationTurn(
  turnId: string,
  status: Exclude<ConversationTurn['status'], 'running'>,
  result?: string,
  error?: string,
): void {
  getDatabase().prepare(`
    UPDATE conversation_turns
    SET status = ?, result = ?, error = ?, updated_at = ?
    WHERE turn_id = ?
  `).run(status, result ?? null, error ?? null, new Date().toISOString(), turnId);
}

/** 服务启动后把上一次进程遗留的 running turn 标记为 aborted。 */
export function recoverRunningConversationTurns(): number {
  const result = getDatabase().prepare(`
    UPDATE conversation_turns
    SET status = 'aborted',
        error = 'Server restarted while this turn was running.',
        updated_at = ?
    WHERE status = 'running'
  `).run(new Date().toISOString());
  return Number(result.changes);
}

/** 在确认旧 turn 已无人执行后，把它安全终止，释放重试机会。 */
export function abortStaleConversationTurn(turnId: string, error = 'The previous process did not complete this turn.'): boolean {
  const result = getDatabase().prepare(`
    UPDATE conversation_turns
    SET status = 'aborted', error = ?, updated_at = ?
    WHERE turn_id = ? AND status = 'running'
  `).run(error, new Date().toISOString(), turnId);
  return Number(result.changes) > 0;
}

export interface ConversationTurnSummary {
  turnId: string;
  sessionName: string;
  status: ConversationTurn['status'];
  createdAt: string;
  updatedAt: string;
  question?: string;
}

/** 按时间倒序读取本次 Investigation 的用户问题轮次；用于轨迹页补全旧记录。 */
export function listConversationTurns(sessionName: string, limit = 200): ConversationTurnSummary[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
  const rows = dbOrThrow().prepare(`
    SELECT
      t.turn_id,
      t.session_name,
      t.status,
      t.created_at,
      t.updated_at,
      (
        SELECT m.content
        FROM conversation_messages m
        WHERE m.message_id = t.turn_id || ':user'
        LIMIT 1
      ) AS question
    FROM conversation_turns t
    WHERE t.session_name = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(sessionName, safeLimit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    turnId: String(row.turn_id),
    sessionName: String(row.session_name),
    status: row.status as ConversationTurn['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.question === 'string' && row.question.trim() ? { question: row.question } : {}),
  }));
}
/** 查询当前 Investigation 是否存在 running turn。 */
export function getRunningConversationTurn(sessionName: string): ConversationTurn | undefined {
  const row = getDatabase().prepare(`
    SELECT turn_id, session_name, status, result, error, created_at, updated_at
    FROM conversation_turns
    WHERE session_name = ? AND status = 'running'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(sessionName) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    turnId: String(row.turn_id),
    sessionName: String(row.session_name),
    status: row.status as ConversationTurn['status'],
    ...(typeof row.result === 'string' ? { result: row.result } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 根据 turnId 获取完整 durable turn 状态。 */
export function getConversationTurn(turnId: string): ConversationTurn | undefined {
  const row = getDatabase().prepare(`
    SELECT turn_id, session_name, status, result, error, created_at, updated_at
    FROM conversation_turns WHERE turn_id = ?
  `).get(turnId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    turnId: String(row.turn_id),
    sessionName: String(row.session_name),
    status: row.status as ConversationTurn['status'],
    ...(typeof row.result === 'string' ? { result: row.result } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 幂等写入一条对话消息；重复 message id 会返回已有记录。 */
export function saveConversationMessage(input: MessageWrite): ConversationMessage & { rowId: number } {
  const db = getDatabase();
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO conversation_messages (
      message_id, session_name, role, content, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO NOTHING
  `).run(id, input.sessionName, input.role, input.content, createdAt);

  if (Number(result.changes) === 0) {
    const row = db.prepare(`
      SELECT id, message_id, session_name, role, content, created_at
      FROM conversation_messages
      WHERE message_id = ?
    `).get(id) as (MessageRow & { id: number }) | undefined;

    if (!row) throw new Error('Conversation message could not be stored: ' + id);
    return { ...toMessage(row), rowId: row.id };
  }

  const row = db.prepare(`
    SELECT id, message_id, session_name, role, content, created_at
    FROM conversation_messages
    WHERE message_id = ?
  `).get(id) as (MessageRow & { id: number }) | undefined;

  if (!row) throw new Error('Conversation message could not be loaded: ' + id);
  return { ...toMessage(row), rowId: row.id };
}

/** 按时间顺序读取最近一段对话，限制最大返回量避免 UI/Agent 上下文过大。 */
export function listConversationMessages(
  sessionName: string,
  limit = 200,
): ConversationMessage[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
  const rows = dbOrThrow().prepare(`
    SELECT message_id, session_name, role, content, created_at
    FROM conversation_messages
    WHERE session_name = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(sessionName, safeLimit) as unknown as MessageRow[];

  return rows.reverse().map(toMessage);
}

/** 使用 SQLite FTS5 检索历史对话，把当前问题相关的旧消息提供给 Agent。 */
export function searchConversation(
  sessionName: string,
  query: string,
  options: { limit?: number; beforeRowId?: number } = {},
): ConversationSearchHit[] {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return [];

  const safeLimit = Math.max(1, Math.min(Math.trunc(options.limit ?? 8), 50));
  const matchQuery = terms
    .slice(0, 12)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');

  const beforeClause = options.beforeRowId === undefined ? '' : 'AND m.id < ?';
  const params: Array<string | number> = [matchQuery, sessionName];
  if (options.beforeRowId !== undefined) params.push(options.beforeRowId);
  params.push(safeLimit);

  const rows = dbOrThrow().prepare(`
    SELECT
      m.message_id,
      m.session_name,
      m.role,
      m.content,
      m.created_at,
      bm25(conversation_messages_fts) AS score
    FROM conversation_messages_fts
    JOIN conversation_messages m
      ON m.id = conversation_messages_fts.rowid
    WHERE conversation_messages_fts MATCH ?
      AND m.session_name = ?
      ${beforeClause}
    ORDER BY score ASC, m.id DESC
    LIMIT ?
  `).all(...params) as unknown as MessageRow[];

  return rows.map((row) => ({
    ...toMessage(row),
    score: Number(row.score ?? 0),
  }));
}

/** 返回对话数量和最后消息时间，用于 Session 列表和 UI 摘要。 */
export function getConversationSummary(sessionName: string): ConversationSummary {
  const row = dbOrThrow().prepare(`
    SELECT COUNT(*) AS count, MAX(created_at) AS last_message_at
    FROM conversation_messages
    WHERE session_name = ?
  `).get(sessionName) as { count: number; last_message_at?: string | null };

  return {
    count: Number(row.count ?? 0),
    ...(row.last_message_at ? { lastMessageAt: row.last_message_at } : {}),
  };
}

/** 把旧 context.json 中的 conversation inputs 一次性迁入 SQLite，并从 context 中删除副本。 */
