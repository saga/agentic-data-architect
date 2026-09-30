/**
 * Evidence Retrieval：按问题组织有限上下文。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import type { DataProfile } from '../adapters/database.js';
import type { EvidenceRef, Finding } from '../evidence/types.js';
import type { LineageGraph } from './lineage.js';

/**
 * Evidence Retrieval（§十八）：按问题取相关节点/边/profile/finding，
 * 不再把整个 snapshot 截断塞给模型。
 */

export interface QuestionContext {
  text: string;
  evidenceIds: string[];
}

/** 把自然语言问题切成用于数据集粗匹配的关键词；这里只做轻量检索，不做语义模型。 */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
}

/** 根据问题关键词和数据集名称计算简单相关性分数，用于控制 Agent 上下文规模。 */
function scoreDataset(questionTokens: string[], dataset: string): number {
  const parts = dataset.toLowerCase().split(/[._]+/);
  let score = 0;
  for (const q of questionTokens) {
    for (const p of parts) {
      if (p === q) score += 3;
      else if (p.includes(q) || q.includes(p)) score += 1;
    }
  }
  return score;
}

/** 从 lineage、profile、finding 和 evidence 中挑选与问题最相关的上下文，避免把整个 snapshot 塞给模型。 */
export function buildQuestionContext(args: {
  question: string;
  lineage: LineageGraph | null;
  profiles: DataProfile[];
  findings: Finding[];
  evidence: EvidenceRef[];
  maxDatasets?: number;
}): QuestionContext {
  const { question, lineage, profiles, findings, evidence } = args;
  const qt = tokens(question);
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: string[] = [];
  const usedIds: string[] = [];
  const use = (id: string) => {
    const e = byId.get(id);
    if (e && !usedIds.includes(id)) {
      usedIds.push(id);
      return `[${id}] ${e.source}`;
    }
    return null;
  };

  if (!lineage) {
    return { text: '(no discovery yet — run discover first)', evidenceIds: [] };
  }
  const ranked = lineage.tables
    .filter((t) => !t.startsWith('file:'))
    .map((t) => ({ t, s: scoreDataset(qt, t) }))
    .sort((a, b) => b.s - a.s);
  const top = (ranked.filter((r) => r.s > 0).length > 0 ? ranked.filter((r) => r.s > 0) : ranked).slice(
    0,
    args.maxDatasets ?? 6,
  );
  const topNames = new Set(top.map((r) => r.t.toLowerCase()));

  out.push(`Related datasets: ${top.map((r) => r.t).join(', ') || '(none scored)'}`);
  out.push('');
  out.push('Lineage:');
  let edgeCount = 0;
  for (const e of lineage.edges) {
    if (!topNames.has(e.source.toLowerCase()) && !topNames.has(e.target.toLowerCase())) continue;
    if (edgeCount >= 20) {
      out.push(`... and more (narrow the question to see them)`);
      break;
    }
    const ref = use(e.evidenceId);
    out.push(`- ${e.source} → ${e.target}${ref ? ` ${ref}` : ''}`);
    edgeCount++;
  }
  if (edgeCount === 0) out.push('(no lineage edges for these datasets)');

  out.push('');
  out.push('Columns:');
  let colCount = 0;
  for (const c of lineage.columns) {
    if (!topNames.has(c.targetDataset.toLowerCase()) && !topNames.has(c.sourceDataset.toLowerCase())) continue;
    if (colCount >= 30) break;
    const ref = c.evidenceId ? use(c.evidenceId) : null;
    out.push(`- ${c.targetDataset}.${c.targetColumn} ← ${c.sourceDataset}.${c.sourceColumn} (${c.expression?.slice(0, 120) ?? ''})${ref ? ` ${ref}` : ''}`);
    colCount++;
  }
  if (colCount === 0) out.push('(no column lineage)');

  const relProfiles = profiles.filter((p) => topNames.has(p.dataset.toLowerCase()));
  if (relProfiles.length > 0) {
    out.push('');
    out.push('Profiles:');
    for (const p of relProfiles) {
      const profileEvidence = evidence.find((e) => e.type === 'profiling' && e.dataset?.toLowerCase() === p.dataset.toLowerCase() && !e.column);
      const profileRef = profileEvidence ? use(profileEvidence.id) : null;
      out.push(`- ${p.dataset}: rows=${p.rowCount}${profileRef ? ` ${profileRef}` : ''}`);
      for (const c of p.columns.slice(0, 12)) {
        const columnEvidence = evidence.find((e) => e.type === 'profiling' && e.dataset?.toLowerCase() === p.dataset.toLowerCase() && e.column?.toLowerCase() === c.column.toLowerCase());
        const columnRef = columnEvidence ? use(columnEvidence.id) : null;
        out.push(`  - ${c.column} [${c.dataType}] null=${(c.nullRate * 100).toFixed(1)}% distinct=${(c.distinctRate * 100).toFixed(1)}%${columnRef ? ` ${columnRef}` : ''}`);
      }
    }
  }

  const relFindings = findings.filter((f) => f.affectedAssets.some((a) => topNames.has(a.toLowerCase())));
  if (relFindings.length > 0) {
    out.push('');
    out.push('Findings:');
    for (const f of relFindings) {
      out.push(`- [${f.status}] ${f.title}: ${f.description.slice(0, 300)}`);
      for (const id of f.evidenceIds.slice(0, 5)) {
        const ref = use(id);
        if (ref) out.push(`  ${ref}`);
      }
    }
  }
  return { text: out.join('\n'), evidenceIds: usedIds };
}
