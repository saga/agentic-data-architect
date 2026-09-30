/**
 * 金融场景审查清单（§二十五）：deterministic checklist，不是 ontology。
 * FIBO 不进 runtime（§二十二），这里只检查“该有的证据有没有”。
 */

export const investmentChecks: Record<string, string[]> = {
  position: ['authoritative_source', 'position_state', 'as_of_time', 'security_identifier', 'corporate_action', 'fx'],
  security: ['canonical_identifier', 'identifier_mapping', 'lifecycle'],
  price: ['source_precedence', 'raw_or_adjusted', 'valuation_date', 'currency', 'timezone'],
  research: ['publication_time', 'knowledge_time', 'restatement', 'point_in_time'],
};

export interface CheckGap {
  domain: string;
  check: string;
  question: string;
}

const CHECK_QUESTIONS: Record<string, string> = {
  authoritative_source: '哪个系统是权威源？',
  position_state: '包含哪些头寸状态（预估/已成交/已结算/账务）？',
  as_of_time: 'as-of 时间是哪个字段？',
  security_identifier: '用哪个证券 ID 关联？',
  corporate_action: '公司行动如何调整？',
  fx: '外汇如何折算？',
  canonical_identifier: '标准证券 ID 是哪个？',
  identifier_mapping: '标识映射表在哪里？',
  lifecycle: '退市/ inactive 证券怎么表示？',
  source_precedence: '主价格源和 fallback 顺序是什么？',
  raw_or_adjusted: '原始价还是复权价？',
  valuation_date: '估值日期是哪个字段？',
  currency: '币种字段在哪里？',
  timezone: '时区口径是什么？',
  publication_time: '发布时间字段在哪里？',
  knowledge_time: 'knowledge time 和发布时间分开吗？',
  restatement: '重述历史保留吗？',
  point_in_time: '能还原研究时点可见的数据吗？',
};

/**
 * 极简判定：dataset 名命中 domain 关键词，且列名里找不到对应检查的关键词，
 * 就记一个 gap（问题），不直接判 finding —— 证据不足时诚实地问。
 */
const CHECK_COLUMN_HINTS: Record<string, string[]> = {
  as_of_time: ['asof', 'as_of', 'date', 'time'],
  valuation_date: ['valuation', 'date', 'time'],
  publication_time: ['publish', 'publication', 'release'],
  knowledge_time: ['knowledge'],
  currency: ['currency', 'ccy'],
  position_state: ['status', 'state', 'type'],
  security_identifier: ['security_id', 'sec_id', 'isin', 'ticker'],
  canonical_identifier: ['security_id', 'sec_id', 'isin'],
};

const DOMAIN_HINTS: Record<string, string[]> = {
  position: ['position', 'holding'],
  security: ['security', 'instrument'],
  price: ['price'],
  research: ['research', 'fundamental', 'estimate'],
};

export function checkDomainGaps(datasets: { name: string; columns: string[] }[]): CheckGap[] {
  const gaps: CheckGap[] = [];
  for (const ds of datasets) {
    const lower = ds.name.toLowerCase();
    for (const [domain, hints] of Object.entries(DOMAIN_HINTS)) {
      if (!hints.some((h) => lower.includes(h))) continue;
      for (const check of investmentChecks[domain] ?? []) {
        const colHints = CHECK_COLUMN_HINTS[check];
        if (!colHints) continue; // 没有列级启发式的检查（如权威源）交给 findings 问
        const cols = ds.columns.map((c) => c.toLowerCase());
        if (!colHints.some((h) => cols.some((c) => c.includes(h)))) {
          gaps.push({ domain, check, question: `${ds.name}：${CHECK_QUESTIONS[check] ?? check}` });
        }
      }
    }
  }
  return gaps;
}
