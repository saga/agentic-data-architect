/**
 * Graphify 结构分析适配层。
 *
 * Graphify 负责代码/SQL/文档的结构关系发现，本项目只负责：
 * 1. 为每个 Investigation 指定独立 graph.json；
 * 2. 把 Graphify MCP 作为一个可替换的 structural-analysis capability 注入 Copilot；
 * 3. 保持 Graphify 的输出停留在“导航/候选关系”层，不直接写入 Evidence。
 *
 * Graphify 本身是 Python 工具，因此这里不引入其内部实现或 Python API。
 * 运行时通过它提供的 graphify / graphify-mcp CLI，不引入 Graphify Python API。
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { GraphifyRunMetadata } from '../evidence/types.js';
export type { GraphifyRunMetadata } from '../evidence/types.js';

export const GRAPHIFY_MCP_NAME = 'graphify-structural-analysis';
const execFileAsync = promisify(execFile);

const GRAPHIFY_CLI_TIMEOUT_MS = 120_000;

export interface GraphifyMcpServer {
  name: typeof GRAPHIFY_MCP_NAME;
  graphPath: string;
  server: {
    type: 'local';
    command: string;
    args: string[];
    tools: string[];
  };
}

/** 返回当前 Investigation 的 Graphify graph.json，和 Agent workingDirectory 保持一一对应。 */
export function graphifyGraphPath(workingDirectory: string): string {
  return path.join(path.resolve(workingDirectory), 'graphify-out', 'graph.json');
}

/** 在当前 Node 进程 PATH 中可执行的本地 Graphify 命令。 */
function commandExists(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'ignore',
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

/** 找到项目 .venv 中的 graphify/graphify-mcp，保证 Agent 的 bash 也能直接使用 graphify。 */
export function prepareGraphifyEnvironment(): string | undefined {
  if (!config.graphifyEnabled) return undefined;

  const venvBin = process.platform === 'win32'
    ? path.resolve('.venv', 'Scripts')
    : path.resolve('.venv', 'bin');

  const graphifyMcp = path.join(venvBin, process.platform === 'win32' ? 'graphify-mcp.exe' : 'graphify-mcp');
  if (!fs.existsSync(graphifyMcp)) return undefined;

  const currentPath = process.env.PATH ?? '';
  if (!currentPath.split(path.delimiter).includes(venvBin)) {
    process.env.PATH = [venvBin, currentPath].filter(Boolean).join(path.delimiter);
  }
  return graphifyMcp;
}

/** 找到 Graphify CLI / MCP executable；显式配置优先，没有则寻找项目 .venv / PATH。 */
export function resolveGraphifyCliCommand(): string | undefined {
  if (!config.graphifyEnabled) return undefined;

  const mcp = resolveGraphifyMcpCommand();
  if (mcp) {
    const candidate = path.join(
      path.dirname(mcp),
      process.platform === 'win32' ? 'graphify.exe' : 'graphify',
    );
    if (fs.existsSync(candidate)) return candidate;
  }

  return commandExists('graphify') ? 'graphify' : undefined;
}

/**
 * 确保当前 Investigation 的 structural graph 真正存在。
 *
 * 第一次使用时生成 graph；Discovery 需要刷新时调用 refresh=true。
 * 这里直接执行 Graphify CLI，而不是只记录“Graphify 可用”，这样后续 MCP 查询有真实图可读。
 */
export async function ensureGraphifyGraph(
  workingDirectory: string,
  refresh = false,
): Promise<GraphifyRunMetadata> {
  const capturedAt = new Date().toISOString();
  if (!config.graphifyEnabled) {
    return { enabled: false, status: 'disabled', capturedAt };
  }

  prepareGraphifyEnvironment();
  const cli = resolveGraphifyCliCommand();
  if (!cli) {
    throw new Error(
      'Graphify 已启用，但本机没有找到 Graphify。请先执行 uv sync；如果这次调查不需要结构分析，再关闭 GRAPHIFY_ENABLED。',
    );
  }

  const graphPath = graphifyGraphPath(workingDirectory);
  const graphExists = await fs.promises.access(graphPath).then(() => true).catch(() => false);
  if (!refresh && graphExists) {
    const metadata = await getGraphifyRuntimeMetadata(workingDirectory);
    if (metadata.status === 'available' && metadata.graphHash) return metadata;
  }

  const action = graphExists ? 'update' : 'extract';
  const args = graphExists
    ? ['update', path.resolve(workingDirectory), '--no-viz']
    : ['extract', path.resolve(workingDirectory), '--code-only', '--no-viz'];

  try {
    await execFileAsync(cli, args, {
      cwd: path.resolve(workingDirectory),
      env: process.env,
      timeout: GRAPHIFY_CLI_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error('Graphify ' + action + ' 没有成功完成：' + detail);
  }

  const metadata = await getGraphifyRuntimeMetadata(workingDirectory);
  if (metadata.status !== 'available' || !metadata.graphHash) {
    throw new Error('Graphify 已执行，但没有生成可以查询的结构图。请检查 Graphify 输出。');
  }
  return metadata;
}

/** 给 Agent 的结构分析选择规则；具体工具名仍由 Copilot/OpenCode 的 MCP 层提供。 */
export const GRAPHIFY_SELECTION_INSTRUCTION = [
  '当前代码库已经准备好 Graphify 结构分析能力。',
  '遇到调用链、依赖关系、上下游、路径、结构枢纽、子系统边界或代码/SQL 对象关系问题时，先使用 Graphify，再用源码工具核对原始内容。',
  '不要用 grep/find/view/bash 反复模拟 Graphify 能直接回答的结构关系。',
  '精确字符串、文件发现、Git diff 和已知文件读取仍直接使用常规工具。',
  'Graphify 只提供结构导航；正式结论必须回到源码、SQL、metadata 或 Evidence。',
].join('\n');

/** 判断一次工具调用是否已经使用 Graphify；兼容 Copilot MCP 字段和规范化工具名。 */
export function isGraphifyTool(input: {
  toolName?: unknown;
  mcpServerName?: unknown;
  mcpToolName?: unknown;
}): boolean {
  const values = [input.toolName, input.mcpServerName, input.mcpToolName]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  return values.some((value) =>
    value === GRAPHIFY_MCP_NAME
    || value.startsWith(GRAPHIFY_MCP_NAME + '_')
    || value.startsWith(GRAPHIFY_MCP_NAME + '.')
    || value === 'graphify'
    || value.startsWith('graphify_'),
  );
}

/** 当 Graphify 已启用时要求 MCP executable 必须存在；避免服务“正常启动但能力其实失效”。 */
export function requireGraphifyMcpCommand(): string {
  const command = resolveGraphifyMcpCommand();
  if (!command) {
    throw new Error(
      'Graphify structural analysis is enabled but graphify-mcp was not found. Run `uv sync` or set GRAPHIFY_MCP_COMMAND; set GRAPHIFY_ENABLED=false only when the capability is intentionally disabled.',
    );
  }
  return command;
}

export function resolveGraphifyMcpCommand(): string | undefined {
  if (!config.graphifyEnabled) return undefined;

  const configured = config.graphifyMcpCommand;
  if (configured.includes('/') || configured.includes('\\')) {
    return fs.existsSync(configured) ? configured : undefined;
  }

  const local = prepareGraphifyEnvironment();
  if (local) return local;
  return commandExists(configured) ? configured : undefined;
}

/**
 * 为一个 Copilot Session 构造 Graphify MCP 配置。
 *
 * 即使 graph.json 还不存在，Graphify MCP 也允许启动；Skill 会先运行
 * 'graphify extract . --code-only --no-viz'，随后 MCP 查询会自动读取新 graph。
 */
export function buildGraphifyMcpServer(
  workingDirectory: string,
  commandOverride?: string,
): GraphifyMcpServer | undefined {
  const command = commandOverride ?? requireGraphifyMcpCommand();
  if (!command) return undefined;

  const graphPath = graphifyGraphPath(workingDirectory);
  return {
    name: GRAPHIFY_MCP_NAME,
    graphPath,
    server: {
      type: 'local',
      command,
      args: ['--graph', graphPath],
      tools: [
        'query_graph',
        'get_node',
        'get_neighbors',
        'get_community',
        'god_nodes',
        'graph_stats',
        'shortest_path',
      ],
    },
  };
}


/** 读取 graph.json 的 SHA-256，作为本轮结构图快照的可重放指纹。 */
async function graphHash(graphPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.promises.readFile(graphPath);
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return undefined;
  }
}

/** 尽量从 graphify-mcp 所在 Python 环境读取 graphifyy 版本；失败时保留命令但不伪造版本。 */
function graphifyPackageVersion(command: string): string | undefined {
  const candidatePython = path.join(path.dirname(command), process.platform === 'win32' ? 'python.exe' : 'python');
  const python = fs.existsSync(candidatePython) ? candidatePython : (process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'));
  try {
    return execFileSync(python, ['-c', "import importlib.metadata as m; print(m.version('graphifyy'))"], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    }).toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 返回当前 Investigation 实际看到的 Graphify runtime + graph 快照。 */
export async function getGraphifyRuntimeMetadata(workingDirectory: string): Promise<GraphifyRunMetadata> {
  const capturedAt = new Date().toISOString();
  if (!config.graphifyEnabled) {
    return { enabled: false, status: 'disabled', capturedAt };
  }
  const command = resolveGraphifyMcpCommand();
  if (!command) {
    return { enabled: true, status: 'missing', capturedAt };
  }
  const graphPath = graphifyGraphPath(workingDirectory);
  const hash = await graphHash(graphPath);
  const packageVersion = graphifyPackageVersion(command);
  return {
    enabled: true,
    status: 'available',
    command,
    ...(packageVersion ? { packageVersion } : {}),
    graphPath,
    ...(hash ? { graphHash: hash } : {}),
    extractionMode: '--code-only --no-viz',
    capturedAt,
  };
}

/** 启动 Copilot 前做一次显式依赖检查，避免能力静默降级。 */
export function assertGraphifyRuntimeAvailable(): void {
  if (config.graphifyEnabled) requireGraphifyMcpCommand();
}
