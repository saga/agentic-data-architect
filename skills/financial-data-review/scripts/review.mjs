#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const sessionName = process.argv[2];
if (!sessionName) {
  console.error('usage: node skills/financial-data-review/scripts/review.mjs <session-name>');
  process.exit(2);
}

const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? '.workspace');
const sessionDir = path.join(workspaceDir, sessionName);
const contextFile = path.join(sessionDir, 'context.json');
const discoveryDir = path.join(sessionDir, 'discovery');
const artifactFile = path.join(sessionDir, 'artifacts', 'financial-data-review.json');

const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
const snapshotFiles = fs.readdirSync(discoveryDir).filter((name) => name.endsWith('.json')).sort();

if (snapshotFiles.length === 0) {
  writeResult({
    sessionName,
    generatedAt: new Date().toISOString(),
    status: 'no_discovery',
    observations: [],
    questions: ['先运行 discovery，再做金融领域检查。'],
  });
  process.exit(0);
}

const snapshotPath = path.join(discoveryDir, snapshotFiles[snapshotFiles.length - 1]);
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const lineage = snapshot.lineage ?? { tables: [], columns: [] };
const profiles = snapshot.profiles ?? [];
const evidence = context.evidence ?? [];

const domainRules = {
  position: {
    aliases: ['position', 'pos_qty', 'posqty', 'holding'],
    checks: {
      authoritative_source: ['authoritative'],
      position_state: ['status', 'state', 'type'],
      as_of_time: ['asof', 'as_of', 'date', 'time'],
      security_identifier: ['security_id', 'sec_id', 'isin', 'ticker'],
      corporate_action: [],
      fx: ['fx', 'currency', 'ccy'],
    },
  },
  security: {
    aliases: ['security', 'instrument'],
    checks: {
      canonical_identifier: ['security_id', 'sec_id', 'isin'],
      identifier_mapping: [],
      lifecycle: ['status', 'state', 'active', 'inactive', 'delisted'],
    },
  },
  price: {
    aliases: ['price', 'px_', '_px', 'quote'],
    checks: {
      source_precedence: [],
      raw_or_adjusted: ['adjusted', 'raw'],
      valuation_date: ['valuation', 'date', 'time'],
      currency: ['currency', 'ccy'],
      timezone: ['timezone', 'tz'],
    },
  },
  research: {
    aliases: ['research', 'fundamental', 'estimate'],
    checks: {
      publication_time: ['publish', 'publication', 'release'],
      knowledge_time: ['knowledge'],
      restatement: ['restated', 'restatement', 'revision', 'revised'],
      point_in_time: ['asof', 'as_of', 'knowledge', 'vintage'],
    },
  },
};

function evidenceFor(asset) {
  const lower = asset.toLowerCase();
  return [...new Set(evidence.filter((item) => {
    const dataset = String(item.dataset ?? '').toLowerCase();
    return dataset && (
      lower === dataset ||
      lower.startsWith(dataset + '.') ||
      String(item.source ?? '').toLowerCase().includes(lower)
    );
  }).map((item) => item.id))];
}

function columnsByDataset() {
  const map = new Map();
  const add = (dataset, column) => {
    const list = map.get(dataset) ?? [];
    list.push(column);
    map.set(dataset, list);
  };
  for (const item of lineage.columns ?? []) {
    add(item.targetDataset, item.targetColumn);
    add(item.sourceDataset, item.sourceColumn);
  }
  for (const profile of profiles) {
    for (const column of profile.columns ?? []) add(profile.dataset, column.column);
  }
  return map;
}

const observations = [];
const questions = [];
const cols = columnsByDataset();
const datasets = [...new Set((lineage.tables ?? []).filter((name) => !name.startsWith('file:')))].sort();

for (const [domain, rule] of Object.entries(domainRules)) {
  const candidates = datasets.filter((dataset) => {
    const lower = dataset.toLowerCase();
    return rule.aliases.some((alias) => lower.includes(alias));
  });

  if (candidates.length >= 2) {
    observations.push({
      type: 'multiple_sources_of_truth',
      domain,
      severity: 'high',
      title: '多个疑似 ' + domain + ' 数据集',
      description: '发现 ' + candidates.length + ' 个疑似 ' + domain + ' dataset，需要确认哪个是权威源，哪些只是缓存或派生。',
      affectedAssets: candidates,
      evidenceIds: [...new Set(candidates.flatMap(evidenceFor))],
    });
    questions.push(domain + ' 的权威源是哪个？');
  }

  for (const dataset of candidates) {
    const datasetColumns = (cols.get(dataset) ?? []).map((column) => column.toLowerCase());
    for (const [check, hints] of Object.entries(rule.checks)) {
      if (hints.length === 0) continue;
      const present = hints.some((hint) => datasetColumns.some((column) => column.includes(hint)));
      if (!present) questions.push(dataset + '：缺少可识别的 ' + check + ' 语义，需要确认字段或业务定义。');
    }
  }
}

const identifierPatterns = [
  'security_id', 'sec_id', 'ticker', 'isin', 'cusip',
  'sedol', 'figi', 'bloomberg_id', 'internal_id',
];
const identifierVariants = new Map();
for (const item of lineage.columns ?? []) {
  const normalized = String(item.sourceColumn ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const pattern of identifierPatterns) {
    if (!normalized.includes(pattern.replace(/[^a-z0-9]/g, ''))) continue;
    const set = identifierVariants.get(pattern) ?? new Set();
    set.add(item.sourceColumn);
    identifierVariants.set(pattern, set);
  }
}

const spellings = [...new Set([...identifierVariants.values()].flatMap((set) => [...set]).map((value) => value.toLowerCase()))];
if (spellings.length >= 2 || identifierVariants.size >= 2) {
  const affectedAssets = [...new Set((lineage.columns ?? []).map((item) => item.sourceDataset))].slice(0, 10);
  observations.push({
    type: 'identifier_fragmentation',
    domain: 'security',
    severity: 'medium',
    title: '证券标识存在多个字段写法',
    description: '发现标识写法：' + spellings.join('、') + '。需要确认 canonical security identifier 和 mapping owner。',
    affectedAssets,
    evidenceIds: [...new Set(affectedAssets.flatMap(evidenceFor))],
  });
  questions.push('哪个是 canonical security ID？标识映射在哪里维护？');
}

const timeHints = ['date', 'time', '_at', 'asof', 'as_of', 'effective', 'knowledge', 'publication', 'vintage', 'fiscal'];
const temporalDomains = ['position', 'holding', 'price', 'valuation', 'portfolio', 'transaction', 'trade', 'performance', 'research', 'fundamental', 'estimate'];
for (const [dataset, columns] of cols) {
  if (dataset.startsWith('file:')) continue;
  if (!temporalDomains.some((hint) => dataset.toLowerCase().includes(hint))) continue;
  const hasTime = columns.some((column) => timeHints.some((hint) => column.toLowerCase().includes(hint)));
  if (!hasTime) {
    observations.push({
      type: 'temporal_risk',
      domain: 'financial',
      severity: 'medium',
      title: dataset + ' 看不到明显的时间语义',
      description: '无法仅根据当前 schema 判断这是 current truth、historical snapshot 还是 point-in-time 数据。',
      affectedAssets: [dataset],
      evidenceIds: evidenceFor(dataset),
    });
    questions.push(dataset + ' 的时间语义是什么？as-of / knowledge time 分别对应什么？');
  }
}

writeResult({
  sessionName,
  generatedAt: new Date().toISOString(),
  status: 'ok',
  snapshotPath,
  observations,
  questions: [...new Set(questions)].slice(0, 30),
});

function writeResult(result) {
  fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
  fs.writeFileSync(artifactFile, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}