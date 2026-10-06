/** Investigation 路由解析与 URL 构造。 */
import { WorkflowIdSchema, type WorkflowId } from '../../../src/api/contracts.js';

export type PageId = 'chat' | 'config' | 'trajectory' | 'journey' | 'results';
export interface RouteInfo { session: string; page: PageId; }

export function parseRoute(pathname: string = window.location.pathname): RouteInfo | undefined {
  const match = pathname.match(/^\/investigations\/([^/]+)(?:\/(config|trajectory|journey|results))?\/?$/);
  if (!match) return undefined;
  return { session: decodeURIComponent(match[1]), page: (match[2] ?? 'chat') as PageId };
}

export function buildInvestigationPath(session: string, page: PageId = 'chat'): string {
  const suffix = page === 'chat' ? '' : '/' + page;
  return '/investigations/' + encodeURIComponent(session) + suffix;
}

export function isWorkflowId(value: string): value is WorkflowId {
  return WorkflowIdSchema.safeParse(value).success;
}
