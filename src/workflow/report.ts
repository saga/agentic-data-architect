import { buildReport } from '../analysis/report.js';

/** report 的 workflow 入口（纯透传，保持 cli → workflow → analysis 分层）。 */
export async function runReport(name: string): Promise<{ markdown: string; path: string }> {
  return buildReport(name);
}
