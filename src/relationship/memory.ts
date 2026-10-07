/**
 * Long-term relationship memory.
 *
 * This store is deliberately separate from Investigation state and Control.
 * Only explicitly requested memories are persisted automatically; inferred
 * preferences are not promoted into durable memory in this first version.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type RelationshipMemoryCategory =
  | 'preference'
  | 'working_style'
  | 'ongoing_context'
  | 'shared_history'
  | 'explicit_instruction';

export interface RelationshipMemory {
  id: string;
  category: RelationshipMemoryCategory;
  key: string;
  value: string;
  source: 'explicit';
  confidence: number;
  status: 'active' | 'superseded';
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

interface RelationshipMemoryStore {
  schemaVersion: 1;
  memories: RelationshipMemory[];
  updatedAt: string;
}

function memoryFile(): string {
  return path.join(config.dataDir, 'relationship-memory.json');
}

async function writeAtomic(value: RelationshipMemoryStore): Promise<void> {
  await fs.mkdir(path.dirname(memoryFile()), { recursive: true });
  const temporary = memoryFile() + '.tmp-' + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, memoryFile());
}

async function loadStore(): Promise<RelationshipMemoryStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(memoryFile(), 'utf8')) as Partial<RelationshipMemoryStore>;
    return {
      schemaVersion: 1,
      memories: Array.isArray(parsed.memories) ? parsed.memories.filter(Boolean) as RelationshipMemory[] : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, memories: [], updatedAt: new Date().toISOString() };
    }
    throw error;
  }
}

export async function rememberRelationship(
  input: Pick<RelationshipMemory, 'category' | 'key' | 'value'>,
): Promise<RelationshipMemory> {
  const store = await loadStore();
  const now = new Date().toISOString();
  const existing = store.memories.find(
    (item) => item.status === 'active' && item.category === input.category && item.key === input.key,
  );
  if (existing) {
    existing.value = input.value.trim();
    existing.updatedAt = now;
    existing.confidence = 1;
    await writeAtomic({ ...store, updatedAt: now });
    return existing;
  }
  const memory: RelationshipMemory = {
    id: randomUUID(),
    category: input.category,
    key: input.key,
    value: input.value.trim(),
    source: 'explicit',
    confidence: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  store.memories.push(memory);
  await writeAtomic({ ...store, updatedAt: now });
  return memory;
}

/** Explicit-only capture: no behavioural inference is promoted to memory. */
export async function captureExplicitRelationshipMemories(text: string): Promise<RelationshipMemory[]> {
  const source = text.trim();
  if (!source) return [];
  const candidates: Array<Pick<RelationshipMemory, 'category' | 'key' | 'value'>> = [];
  const forgetMatch = source.match(/(?:请)?忘记(?:我)?[：:\s]+(.{2,300})/i);
  if (forgetMatch?.[1]) {
    await forgetRelationshipMemory(forgetMatch[1].trim());
    return [];
  }
  const rememberMatch = source.match(/(?:请)?记住(?:我)?[：:\s]+(.{2,500})/i);
  if (rememberMatch?.[1]) candidates.push({ category: 'explicit_instruction', key: 'user_explicit_memory', value: rememberMatch[1].trim() });
  const avoidMatch = source.match(/以后(?:请)?(?:不要|别)[：:\s]*(.{2,300})/i);
  if (avoidMatch?.[1]) candidates.push({ category: 'preference', key: 'avoid', value: '以后不要' + avoidMatch[1].trim() });
  const styleMatch = source.match(/以后(?:回答|回复|表达)(?:请)?(?:尽量|都)?[：:\s]*(.{2,300})/i);
  if (styleMatch?.[1]) candidates.push({ category: 'working_style', key: 'response_style', value: styleMatch[1].trim() });
  const results: RelationshipMemory[] = [];
  for (const candidate of candidates) {
    if (candidate.value.length >= 2) results.push(await rememberRelationship(candidate));
  }
  return results;
}

/** Retrieve presentation/relationship memories. No embedding dependency is needed at this scale. */
export async function getRelevantRelationshipMemories(query: string, limit = 8): Promise<RelationshipMemory[]> {
  const store = await loadStore();
  const active = store.memories.filter((item) => item.status === 'active');
  if (!active.length) return [];
  const normalized = query.toLowerCase();
  const scored = active.map((memory) => {
    const text = memory.key + ' ' + memory.value;
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
    const overlap = tokens.filter((token) => normalized.includes(token)).length;
    const styleBoost = memory.category === 'preference' || memory.category === 'working_style' ? 1 : 0;
    return { memory, score: overlap * 2 + styleBoost };
  });
  scored.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
  const selected = scored.slice(0, limit).map((item) => item.memory);
  if (selected.length) {
    const selectedIds = new Set(selected.map((item) => item.id));
    const now = new Date().toISOString();
    for (const memory of store.memories) if (selectedIds.has(memory.id)) memory.lastUsedAt = now;
    await writeAtomic({ ...store, updatedAt: now });
  }
  return selected;
}

/** Explicitly supersede matching memories without deleting their history. */
export async function forgetRelationshipMemory(query: string): Promise<number> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const store = await loadStore();
  let changed = 0;
  for (const memory of store.memories) {
    if (memory.status !== 'active') continue;
    if (memory.value.toLowerCase().includes(normalized) || memory.key.toLowerCase().includes(normalized) || normalized.includes(memory.key.toLowerCase())) {
      memory.status = 'superseded';
      memory.updatedAt = new Date().toISOString();
      changed++;
    }
  }
  if (changed) await writeAtomic({ ...store, updatedAt: new Date().toISOString() });
  return changed;
}