import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir, writeJsonAtomic } from './workspace.js';

export interface InvestigationAnalysisArtifactInput {
  turnId: string;
  execution: number;
  question: string;
  purpose: string;
  expectedResult: string;
  answer: string;
  evidenceIds: string[];
  claimSummaries: string[];
  unknowns: string[];
  nextSteps: string[];
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'turn';
}

/** 每个有效调查 turn 留下一份轻量分析记录；它补充 transcript，不替代 transcript。 */
export async function saveInvestigationAnalysisArtifact(
  name: string,
  input: InvestigationAnalysisArtifactInput,
): Promise<string> {
  const directory = path.join(artifactsDir(name), 'analysis');
  await fs.mkdir(directory, { recursive: true });
  const fileName = String(input.execution + 1).padStart(4, '0') + '-' + safeName(input.turnId) + '.md';
  const filePath = path.join(directory, fileName);
  const lines = [
    '# 本轮分析记录',
    '',
    '## 这次要解决什么',
    '',
    input.purpose.trim(),
    '',
    '## 最后希望拿到什么',
    '',
    input.expectedResult.trim(),
    '',
    '## 本轮问题',
    '',
    input.question.trim(),
    '',
    '## 本轮得到的结果',
    '',
    input.answer.trim() || '本轮没有形成可以单独保存的文字结论。',
    '',
    '## 已经用到的资料',
    '',
    input.evidenceIds.length ? input.evidenceIds.map((id) => '- ' + id).join('\n') : '- 本轮没有引用已登记的资料。',
    '',
    '## 还不能确认',
    '',
    input.unknowns.length ? input.unknowns.map((item) => '- ' + item).join('\n') : '- 当前没有新增未确认事项。',
    '',
    '## 下一步',
    '',
    input.nextSteps.length ? input.nextSteps.map((item) => '- ' + item).join('\n') : '- 下一步由当前任务状态决定。',
    '',
  ];
  if (input.claimSummaries.length) {
    lines.push('## 本轮形成的关键结论', '', ...input.claimSummaries.slice(0, 12).map((item) => '- ' + item), '');
  }
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');

  const indexPath = path.join(artifactsDir(name), 'index.json');
  let entries: Array<Record<string, unknown>> = [];
  try {
    entries = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>;
    if (!Array.isArray(entries)) entries = [];
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
  }
  const next = entries.filter((item) => item.path !== path.relative(artifactsDir(name), filePath));
  next.push({
    kind: 'analysis',
    title: '第 ' + String(input.execution + 1) + ' 轮分析记录',
    path: path.relative(artifactsDir(name), filePath),
    turnId: input.turnId,
    createdAt: new Date().toISOString(),
  });
  await writeJsonAtomic(indexPath, next);
  return filePath;
}