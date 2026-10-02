import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ArchitectureKnowledgeBankSchema, type ArchitectureKnowledge } from './schemas.js';
import type { WorkflowId } from '../investigation/schemas.js';

/** 读取并校验 knowledge/data-architecture/*.json；知识文件是仓库中的可审查 source of truth。 */
async function loadKnowledgeFiles(): Promise<ArchitectureKnowledge[]> {
  const directory = path.join(config.knowledgeDir, 'data-architecture');
  let files: string[];
  try {
    files = (await fs.readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const entries: unknown[] = [];
  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`知识库文件必须是数组：${file}`);
    entries.push(...raw);
  }

  return ArchitectureKnowledgeBankSchema.parse(entries);
}

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function chineseBigrams(value: string): string[] {
  const chars = [...value.toLocaleLowerCase()].filter((char) => /[\u3400-\u9fff]/u.test(char));
  const result: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) result.push(chars[i] + chars[i + 1]);
  return result;
}

/**
 * 轻量关键词检索。
 *
 * 仓库里的知识目前是人工精选的小规模 corpus，先用确定性匹配保证“为什么这条知识被注入”容易解释；
 * 等知识规模明显变大后，再考虑独立检索服务。
 */
export async function searchArchitectureKnowledge(
  query: string,
  options: { workflow?: WorkflowId | null; limit?: number },
): Promise<ArchitectureKnowledge[]> {
  const nodes = await loadKnowledgeFiles();
  const queryTokens = new Set(tokens(query));
  const queryChineseBigrams = new Set(chineseBigrams(query));
  const scored = nodes
    .filter((node) => node.status === 'active' && (!options.workflow || node.appliesTo.includes(options.workflow)))
    .map((node) => {
      const haystack = tokens([
        node.title,
        node.summary,
        ...node.tags,
        ...node.inputs,
        ...node.outputs,
        ...node.checks,
      ].join(' '));
      const unique = new Set(haystack);
      const haystackText = [
        node.title,
        node.summary,
        ...node.tags,
        ...node.inputs,
        ...node.outputs,
        ...node.checks,
      ].join(' ').toLocaleLowerCase();
      const textBigrams = new Set(chineseBigrams(haystackText));
      let score = 0;
      for (const token of queryTokens) {
        if (unique.has(token)) score += 1;
      }
      // 中文没有天然空格，补一个轻量二字片段匹配，避免中文问题检索不到中文知识。
      if (queryChineseBigrams.size > 0) {
        let overlap = 0;
        for (const token of queryChineseBigrams) {
          if (textBigrams.has(token)) overlap += 1;
        }
        score += Math.min(overlap, 8) * 0.15;
      }
      if (node.knowledgeConfidence === 'high') score += 0.25;
      return { node, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

  return scored.slice(0, options.limit ?? 6).map((item) => item.node);
}

/** 把知识明确标成“参考资料”，避免 Agent 将它和 Investigation Evidence 混为一谈。 */
export function renderArchitectureKnowledge(nodes: ArchitectureKnowledge[]): string {
  if (!nodes.length) return '';

  const sections = nodes.map((node) => {
    const sourceText = node.sources
      .map((source) => {
        const date = source.publishedAt ? `，资料时间 ${source.publishedAt}` : '';
        return `- ${source.title}（${source.publisher}；来源可信度 ${source.sourceConfidence}${date}；${source.url}）`;
      })
      .join('\n');

    return [
      `### ${node.title}`,
      node.summary,
      `知识可信度：${node.knowledgeConfidence}。复核时间：${node.reviewedAt}。时间敏感度：${node.timeSensitivity}。`,
      `检查点：${node.checks.join('；')}`,
      node.cautions.length ? `注意：${node.cautions.join('；')}` : '',
      `来源：\n${sourceText}`,
    ].filter(Boolean).join('\n');
  });

  return [
    '## General Architecture Knowledge（仅作方法参考，不是本次 Investigation 的事实证据）',
    '使用下面知识时，要区分“来源明确支持的事实”和“本项目整理出的实践建议”。需要当前事实时，继续查 Investigation Evidence。',
    ...sections,
  ].join('\n\n');
}