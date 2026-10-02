/**
 * Graphify 结构分析适配层。
 *
 * Graphify 负责代码/SQL/文档的结构关系发现，本项目只负责：
 * 1. 为每个 Investigation 指定独立 graph.json；
 * 2. 把 Graphify MCP 作为一个可替换的 structural-analysis capability 注入 Copilot；
 * 3. 保持 Graphify 的输出停留在“导航/候选关系”层，不直接写入 Evidence。
 *
 * Graphify 本身是 Python 工具，因此这里不引入其内部实现或 Python API。
 * 运行时只依赖它提供的 graphify-mcp CLI。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const GRAPHIFY_MCP_NAME = 'graphify-structural-analysis';

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

/** 找到 Graphify MCP executable；显式配置优先，没有则寻找项目 .venv / PATH。 */
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
  const command = commandOverride ?? resolveGraphifyMcpCommand();
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
