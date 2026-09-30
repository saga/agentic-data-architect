/**
 * Report Workflow 入口。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { buildReport } from '../analysis/report.js';

/** report 的 workflow 入口（纯透传，保持 cli → workflow → analysis 分层）。 */
export async function runReport(name: string): Promise<{ markdown: string; path: string }> {
  return buildReport(name);
}
