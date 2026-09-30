import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import type { WorkspaceInput } from './workspace.js';

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface ConversationMessage {
  id: string;
  sessionName: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface ConversationSearchHit extends ConversationMessage {
  score: number;
}

export interface ConversationTurn {
  turnId: string;
  sessionName: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

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

export function conversationDbFile(): string {
  return path.join(config.workspaceDir, 'conversations.db');
}

function getDatabase(): DatabaseSync {
  const file = conversationDbFile();
  if (database && databasePath === file) return database;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  database?.close();

  database = new DatabaseSync(file);
  databasePath = file;
  database.exec(`
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

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.message_id,
    sessionName: row.session_name,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

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

export function abortStaleConversationTurn(turnId: string, error = 'The previous process did not complete this turn.'): boolean {
  const result = getDatabase().prepare(`
    UPDATE conversation_turns
    SET status = 'aborted', error = ?, updated_at = ?
    WHERE turn_id = ? AND status = 'running'
  `).run(error, new Date().toISOString(), turnId);
  return Number(result.changes) > 0;
}

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

export function migrateLegacyConversationInputs(
  sessionName: string,
  inputs: WorkspaceInput[],
): WorkspaceInput[] {
  const legacyMessages = inputs.filter(
    (input) =>
      (input.kind === 'question' || input.kind === 'user_message' || input.kind === 'assistant_message') &&
      Boolean(input.content?.trim()),
  );
  if (legacyMessages.length === 0) return inputs;

  for (const input of legacyMessages) {
    saveConversationMessage({
      id: sessionName + ':' + input.id,
      sessionName,
      role: input.kind === 'assistant_message' ? 'assistant' : 'user',
      content: input.content ?? '',
      createdAt: input.capturedAt,
    });
  }

  return inputs.filter(
    (input) => input.kind !== 'question' && input.kind !== 'user_message' && input.kind !== 'assistant_message',
  );
}

export function closeConversationStore(): void {
  database?.close();
  database = undefined;
  databasePath = undefined;
}

function dbOrThrow(): DatabaseSync {
  return getDatabase();
}

function extractSearchTerms(value: string): string[] {
  const segments = value.match(/[\u3400-\u9fff]{2,}|[\p{L}\p{N}_]{3,}/gu) ?? [];
  const terms: string[] = [];

  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/.test(segment)) {
      for (let i = 0; i + 3 <= segment.length; i += 2) {
        terms.push(segment.slice(i, i + 3));
      }
      if (segment.length > 3) terms.push(segment.slice(-3));
    } else {
      terms.push(segment);
    }
  }

  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}
