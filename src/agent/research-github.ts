/**
 * GitHub 仓库研究入口。
 *
 * 目标很简单：用户明确给了 GitHub repository 时，不要求 Agent 先让用户手工 clone。
 * 这里把 repository 固定落到当前 Investigation workspace，然后直接跑现有 Discovery，
 * 让 GitHub 源码进入本项目已有的 Evidence / Lineage / Current-State 链路。
 */
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as z from 'zod';
import { config } from '../config.js';
import { appendContextInput } from '../investigation/workspace.js';
import { loadInvestigation, saveInvestigation } from '../investigation/store.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';
import { runDiscovery } from '../workflow/discover.js';

const execFile = promisify(execFileCallback);

export interface GitHubRepository {
  owner: string;
  name: string;
  url: string;
}

function normalizeRepository(input: string): GitHubRepository {
  const value = input.trim().replace(/\.git$/i, '');
  const match = value.match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s#?]+)$/i);
  if (!match || !match[1] || !match[2]) {
    throw new Error('GitHub 仓库格式不正确，请使用 https://github.com/owner/repository 或 owner/repository。');
  }

  const owner = match[1];
  const name = match[2];
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('GitHub 仓库名称包含无法处理的字符。');
  }

  return {
    owner,
    name,
    url: 'https://github.com/' + owner + '/' + name,
  };
}

export function extractGitHubRepositories(text: string): string[] {
  const values = new Set<string>();
  const regex = /(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
  for (const match of text.matchAll(regex)) {
    if (match[1] && match[2]) values.add(match[1] + '/' + match[2]);
  }
  return [...values];
}

async function gitHead(repoDir: string): Promise<string> {
  const result = await execFile('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}

async function cloneRepository(repository: GitHubRepository, targetDir: string): Promise<void> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  const env = { ...process.env };

  // 只在当前本机已经配置 GITHUB_TOKEN 时给 git clone 增加认证；
  // 不把 token 写进仓库 URL、日志或 Evidence。
  if (config.githubToken) {
    const auth = Buffer.from('x-access-token:' + config.githubToken, 'utf8').toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + auth;
  }

  await execFile(
    'git',
    ['clone', '--depth', '1', repository.url + '.git', targetDir],
    { env, maxBuffer: 4 * 1024 * 1024 },
  );
}

/** 获取 GitHub repository 的本地研究副本，并运行现有确定性 Discovery。 */
export async function researchGitHubRepository(
  investigationName: string,
  repositoryInput: string,
): Promise<{
  repository: GitHubRepository;
  localPath: string;
  commit: string;
  runId: string;
  evidenceIds: string[];
}> {
  const repository = normalizeRepository(repositoryInput);
  const root = path.join(
    config.workspaceDir,
    investigationName,
    'artifacts',
    'github',
    repository.owner + '__' + repository.name,
  );

  let exists = false;
  try {
    await fs.access(path.join(root, '.git'));
    exists = true;
  } catch {
    // 第一次研究。
  }

  if (!exists) await cloneRepository(repository, root);

  const commit = await gitHead(root);
  const currentBeforeRun = await loadInvestigation(investigationName);
  const priorRunForRoot = currentBeforeRun.discoveryRuns.find(
    (run) => path.resolve(run.root) === path.resolve(root),
  );

  if (priorRunForRoot) {
    return {
      repository,
      localPath: root,
      commit,
      runId: priorRunForRoot.id,
      evidenceIds: currentBeforeRun.evidence
        .filter((item) => item.discoveryRunId === priorRunForRoot.id)
        .map((item) => item.id),
    };
  }

  const summary = await runDiscovery(investigationName, { path: root });
  const current = await loadInvestigation(investigationName);

  const originEvidence: EvidenceRef = {
    id: nextId('ev'),
    type: 'documentation',
    investigationId: investigationName,
    discoveryRunId: summary.runId,
    source: 'GitHub repository ' + repository.owner + '/' + repository.name + ' @ ' + commit,
    value: {
      repository: repository.url,
      commit,
      localPath: path.relative(config.workspaceDir, root),
    },
    collectedAt: new Date().toISOString(),
  };
  current.evidence.push(originEvidence);

  for (const evidence of current.evidence) {
    if (evidence.discoveryRunId !== summary.runId || evidence.type !== 'source_file') continue;
    evidence.source =
      'GitHub ' + repository.owner + '/' + repository.name + ' @ ' + commit + ': ' +
      (evidence.file ?? evidence.source);
  }

  await appendContextInput(investigationName, {
    kind: 'research',
    title: 'GitHub：' + repository.owner + '/' + repository.name,
    content: JSON.stringify({
      repository: repository.url,
      commit,
      localPath: path.relative(config.workspaceDir, root),
      discoveryRunId: summary.runId,
    }, null, 2),
    source: 'GitHub repository research',
    uri: repository.url,
    artifactPath: path.relative(path.join(config.workspaceDir, investigationName), root),
    important: true,
  });

  await saveInvestigation(current);

  return {
    repository,
    localPath: root,
    commit,
    runId: summary.runId,
    evidenceIds: current.evidence
      .filter((item) => item.discoveryRunId === summary.runId)
      .map((item) => item.id),
  };
}

export function createGitHubResearchTool(sessionName: string) {
  return defineTool('research_github_repository', {
    description:
      '研究用户明确指定的 GitHub repository：把仓库放入当前 Investigation 的研究目录，并运行现有 Discovery，生成文件 Evidence、SQL lineage 和 Current-State 数据。复杂 legacy repo 优先使用它，不要只做几次零散 GitHub 搜索。',
    parameters: z.object({
      repository: z.string().min(3).describe('GitHub repository，例如 https://github.com/apache/kafka 或 apache/kafka。'),
    }),
    skipPermission: true,
    handler: async ({ repository }) => researchGitHubRepository(sessionName, repository),
  });
}
