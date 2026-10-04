import type { JourneyEdgeKind } from './journey-map-types.js';

const SUCCESS_PATTERNS = [
  'success',
  'succeed',
  'succeeded',
  'pass',
  'passed',
  'complete',
  'completed',
  'done',
  'continue',
  'next',
  'ok',
  'yes',
  '成功',
  '完成',
  '通过',
  '继续',
];

const FAIL_PATTERNS = [
  'fail',
  'failed',
  'failure',
  'error',
  'reject',
  'rejected',
  'deny',
  'denied',
  'stop',
  'stopped',
  '失败',
  '错误',
  '拒绝',
  '不通过',
  '终止',
];

const RETRY_PATTERNS = [
  'retry',
  'rework',
  'redo',
  'revisit',
  'rollback',
  'again',
  'retrying',
  '重试',
  '重新',
  '回退',
];

function matchesPattern(outcome: string, patterns: string[]): boolean {
  return patterns.some((pattern) => outcome.includes(pattern));
}

/**
 * 只决定工作地图怎么画，不改变 Workflow DSL 的 outcome。
 * retry 优先于 fail，避免 rollback-after-fail 一类结果被误判。
 */
export function classifyJourneyEdge(outcome: string | undefined): JourneyEdgeKind {
  const normalized = String(outcome ?? '').trim().toLowerCase();

  if (matchesPattern(normalized, RETRY_PATTERNS)) return 'retry';
  if (matchesPattern(normalized, FAIL_PATTERNS)) return 'fail';
  if (matchesPattern(normalized, SUCCESS_PATTERNS)) return 'success';
  return 'other';
}
