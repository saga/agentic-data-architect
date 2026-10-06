/**
 * Current-State Report 生成器。
 *
 * 这里负责把内部 Discovery / Evidence 结果整理成人可以直接阅读的报告。
 * 它不改变事实，只改变事实的选择、组织和表达方式。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import type { Investigation } from '../investigation/store.js';
import { assertInvestigationScopeGate, isCurrentStateOnlyScope } from '../workflow/scope-gate.js';
import { assertCurrentStateReportGate } from '../workflow/report-gate.js';
import { loadModernizationPlan } from '../workflow/modernization.js';
import {
  datasetLineageRelations,
  edgesFrom,
  edgesTo,
  findNode,
  nodesOfType,
} from '../model/estate-query.js';
import type { DataEstate, EstateNode } from '../model/estate.js';
import type { DiscoverySnapshot } from '../workflow/discover.js';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function preview(values: string[], limit: number): string {
  if (values.length <= limit) return values.join('、');
  return values.slice(0, limit).join('、') + '，另外还有 ' + String(values.length - limit) + ' 项';
}

function evidenceText(ids: string[]): string {
  return ids.length ? '证据：' + unique(ids).slice(0, 3).join('、') : '证据未记录';
}

function impactForFinding(type: string): string {
  switch (type) {
    case 'missing_lineage':
      return '迁移范围还没有完全闭合，受影响对象需要先把来源和下游用途查清楚。';
    case 'multiple_sources_of_truth':
      return '迁移前需要确认哪个来源代表真正业务口径，否则容易把不同系统的数据混在一起。';
    case 'duplicate_transformation':
      return '可能存在重复计算或重复转换，迁移时应先确认这些逻辑是否可以合并。';
    case 'semantic_conflict':
      return '同名字段或指标可能采用了不同业务口径，迁移前需要确认统一定义。';
    case 'identifier_fragmentation':
      return '同一业务对象可能使用多个标识，迁移时需要先确认它们之间的对应关系。';
    case 'data_quality_issue':
      return '数据质量问题会直接影响迁移后的结果校验，需要明确哪些问题可以接受、哪些必须修复。';
    case 'temporal_risk':
      return '时间口径存在风险，迁移时需要明确生效时间、历史数据和时间窗口。';
    case 'possible_stale_documentation':
      return '文档与实际实现可能不一致，迁移依据应优先采用已经验证的代码和数据证据。';
    default:
      return '这个问题需要在进入下一步设计前确认影响范围。';
  }
}

function genericQuestionForFinding(type: string, affectedAssets: string[]): string | undefined {
  const assetText = preview(affectedAssets, 3);
  if (!assetText) return undefined;

  switch (type) {
    case 'missing_lineage':
      return '确认 ' + assetText + ' 的来源、写入过程和下游用途。';
    case 'multiple_sources_of_truth':
      return '确认 ' + assetText + ' 哪一个来源是业务上真正采用的口径。';
    case 'duplicate_transformation':
      return '确认 ' + assetText + ' 涉及的重复转换是否业务等价。';
    case 'semantic_conflict':
      return '确认 ' + assetText + ' 应该采用哪一个业务定义。';
    case 'identifier_fragmentation':
      return '确认 ' + assetText + ' 的多个标识之间是否代表同一业务对象。';
    case 'data_quality_issue':
      return '确认 ' + assetText + ' 的质量问题哪些必须修复，哪些可以接受。';
    case 'temporal_risk':
      return '确认 ' + assetText + ' 的时间口径和历史数据规则。';
    default:
      return undefined;
  }
}

function sourceFileForJob(job: EstateNode): string {
  const sourceFile = job.attributes.sourceFile;
  return typeof sourceFile === 'string' && sourceFile.trim()
    ? sourceFile
    : job.name.replace(/^SQL file:\s*/i, '');
}

function summarizeSqlTransforms(estate: DataEstate, limit = 8): string[] {
  const rows = nodesOfType(estate, 'job').map((job) => {
    const inputEdges = edgesTo(estate, job.id, 'reads_from');
    const outputEdges = edgesFrom(estate, job.id, 'writes_to');
    const sources = inputEdges
      .map((edge) => findNode(estate, edge.from))
      .filter((node): node is EstateNode => node?.type === 'dataset')
      .map((node) => node.name);
    const targets = outputEdges
      .map((edge) => findNode(estate, edge.to))
      .filter((node): node is EstateNode => node?.type === 'dataset')
      .map((node) => node.name);
    const evidenceIds = unique([
      ...inputEdges.flatMap((edge) => edge.evidenceIds),
      ...outputEdges.flatMap((edge) => edge.evidenceIds),
    ]);
    return {
      score: sources.length + targets.length * 2,
      file: sourceFileForJob(job),
      sources: unique(sources),
      targets: unique(targets),
      evidenceIds,
    };
  })
    .filter((row) => row.sources.length > 0 || row.targets.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return rows.map((row) => {
    const sourceText = row.sources.length ? '读取 ' + preview(row.sources, 4) : '没有找到明确输入';
    const targetText = row.targets.length ? '，写入 ' + preview(row.targets, 3) : '，没有明确写入目标';
    return 'SQL 文件 "' + row.file + '"：' + sourceText + targetText + '（' + evidenceText(row.evidenceIds) + '）';
  });
}

function summarizeDatasetFlows(estate: DataEstate, limit = 8): string[] {
  return datasetLineageRelations(estate)
    .sort((a, b) => b.edge.evidenceIds.length - a.edge.evidenceIds.length)
    .slice(0, limit)
    .map((relation) =>
      relation.source.name + ' 是 ' + relation.target.name + ' 的上游数据（' + evidenceText(relation.edge.evidenceIds) + '）',
    );
}

function buildOpenQuestions(
  unknowns: string[],
  findings: Array<{ type: string; affectedAssets: string[]; questions?: string[] | undefined }>,
): string[] {
  const result = unique([
    ...unknowns,
    ...findings.flatMap((finding) => finding.questions ?? []),
    ...findings
      .map((finding) => genericQuestionForFinding(finding.type, finding.affectedAssets))
      .filter((item): item is string => Boolean(item)),
  ]);
  return result.slice(0, 8);
}

function claimStatusText(status: string): string {
  switch (status) {
    case 'verified': return '已验证';
    case 'supported': return '证据较充分';
    case 'inferred': return '目前是推断';
    case 'unknown': return '还不能确认';
    case 'contradicted': return '证据存在冲突';
    default: return status;
  }
}

function buildReplatformImplications(
  findings: Array<{ type: string }>,
  modernization: Awaited<ReturnType<typeof loadModernizationPlan>>,
  modernizationGoal: boolean,
): string[] {
  const implications = unique(findings.map((finding) => impactForFinding(finding.type)));
  if (modernization?.targetArchitecture.components.length) {
    implications.push('已经开始形成目标架构，可以在这些已确认的问题边界内继续细化目标组件。');
  } else if (modernizationGoal) {
    implications.push('当前还没有形成可供批准的目标架构，因此这份报告不能把 replatform 方案说成已经确定。');
  }
  return implications.slice(0, 5);
}

/**
 * Current-State Report（用户阅读版）。
 *
 * 正式报告只展示少量关键事实；完整 Evidence、原始 lineage 和内部指标继续保存在工作区。
 */
export async function buildReport(
  name: string,
  source?: {
    investigation: Investigation;
    snapshot: DiscoverySnapshot | null;
    modernization?: Awaited<ReturnType<typeof loadModernizationPlan>> | null;
  },
): Promise<{ markdown: string; path: string }> {
  if (!source) {
    await assertInvestigationScopeGate(name);
    await assertCurrentStateReportGate(name);
  }

  const inv = source?.investigation ?? await loadInvestigation(name);
  const snapshot = source?.snapshot ?? await loadLatestSnapshot<DiscoverySnapshot>(name);
  const modernization = source
    ? source.modernization ?? null
    : await loadModernizationPlan(name);
  const estate = snapshot?.estate ?? null;
  const current = snapshot?.currentState ?? null;
  const coverage = current?.coverage;
  const datasets = estate ? nodesOfType(estate, 'dataset').map((node) => node.name) : [];
  const sqlFiles = snapshot?.inventory?.files.filter((file) => file.kind === 'sql') ?? [];
  const parsedFiles = new Set((snapshot?.lineage?.statements ?? []).map((statement) => statement.file));
  const sqlParseFailures = coverage?.sqlParseFailures ?? snapshot?.lineage?.parseFailures.length ?? 0;
  const sqlCoverage = sqlFiles.length === 0
    ? '没有发现 SQL 文件'
    : String(parsedFiles.size) + '/' + String(sqlFiles.length) + ' 个 SQL 文件有解析结果';
  const connectedDatasets = coverage
    ? String(coverage.connectedDatasets) + '/' + String(coverage.datasets)
    : '没有 Current-State coverage';
  const columnEdges = coverage?.columnLineageEdges ?? snapshot?.lineage?.columns.length ?? 0;
  const findingInput = inv.findings.map((finding) => ({
    type: finding.type,
    title: finding.title,
    description: finding.description,
    severity: finding.severity,
    status: finding.status,
    affectedAssets: finding.affectedAssets,
    evidenceIds: finding.evidenceIds,
    questions: finding.questions,
  }));
  const openQuestions = buildOpenQuestions(inv.unknowns, findingInput);
  const currentStateOnly = isCurrentStateOnlyScope(inv.goal, inv.scope);
  const modernizationGoal = !currentStateOnly && /replatform|迁移|现代化|改造/i.test((inv.userPrompt + ' ' + inv.goal).trim());
  const implications = buildReplatformImplications(findingInput, modernization, modernizationGoal);
  const datasetFlows = estate ? summarizeDatasetFlows(estate) : [];
  const sqlTransforms = estate ? summarizeSqlTransforms(estate) : [];

  const lines: string[] = [
    '# Current-State Assessment: ' + inv.name,
    '',
    '**用户目标**：' + (inv.userPrompt || inv.goal || '未记录'),
    '',
    modernizationGoal
      ? '这份报告先回答“旧系统现在怎么工作、哪里会影响后续 replatform”。它不是最终目标架构；目标架构尚未形成时，这里不会把草案写成已经确定的方案。'
      : '这份报告先把当前系统、主要问题和证据整理清楚；它不会把尚未形成的后续方案写成已经确定的结论。',
    '',
    '## 1. 结论先说',
    '',
    coverage
      ? '目前已经查到 ' + String(coverage.datasets) + ' 个数据集，' + String(sqlFiles.length) + ' 个 SQL 文件；其中 SQL 解析失败 ' + String(sqlParseFailures) + ' 个，数据集血缘连接为 ' + connectedDatasets + '。'
      : '当前还没有形成完整的 Current-State coverage，不能可靠判断系统全貌。',
    inv.findings.length
      ? '现在最值得注意的是 ' + String(inv.findings.length) + ' 个问题：' + preview(inv.findings.slice(0, 4).map((finding) => finding.title), 4) + '。'
      : '当前没有发现已经形成 Finding 的明显问题。',
    '',
    (modernizationGoal ? '对 replatform 的直接影响：' : '对下一步工作的直接影响：') + (implications[0] ?? '还没有形成可以支撑决策的结论。'),
    '',
    '## 2. 当前系统和数据',
    '',
    inv.systems.length
      ? '涉及的系统包括 ' + preview(inv.systems, 6) + '。'
      : '当前范围中没有记录具体系统。',
    inv.scope.length
      ? '这次重点看的是 ' + preview(inv.scope, 6) + '。'
      : '当前范围没有记录具体业务对象。',
    datasets.length
      ? '已发现的数据集主要包括：' + preview(datasets, 12) + '。'
      : '还没有发现可以展示的数据集。',
    '',
    '## 3. 关键数据流',
    '',
    ...(datasetFlows.length
      ? datasetFlows.map((item) => '- ' + item)
      : ['当前没有形成可直接阅读的数据集上下游关系。']),
    '',
    ...(sqlTransforms.length
      ? ['### 关键 SQL 转换', '', ...sqlTransforms.map((item) => '- ' + item), '']
      : []),
    '## 4. 主要问题',
    '',
    ...(inv.findings.length
      ? inv.findings.slice(0, 8).flatMap((finding) => [
          '### ' + finding.title + '（' + finding.severity + '）',
          '',
          finding.description,
          '',
          '影响：' + impactForFinding(finding.type),
          '',
          finding.affectedAssets.length
            ? '涉及对象：' + preview(finding.affectedAssets, 5)
            : '',
          evidenceText(finding.evidenceIds),
          '',
        ])
      : ['当前没有记录需要单独处理的问题。', '']),
    '## 5. 已形成的关键结论',
    '',
    ...(inv.claims.length
      ? inv.claims.slice(0, 8).flatMap((claim) => [
          '### ' + claimStatusText(claim.status),
          '',
          claim.claim.split('\n')[0].trim(),
          evidenceText(claim.evidenceIds),
          '',
        ])
      : ['当前还没有形成单独保存的关键结论。', '']),
    '## 6. 后续影响',
    '',
    ...(currentStateOnly
      ? ['本次范围明确只做当前状态分析，因此这里不展开目标架构、迁移步骤或新旧映射。', '如后续需要这些内容，再基于已经确认的现状结果启动对应工作。']
      : implications.map((item) => '- ' + item)),
    '',
    currentStateOnly
      ? '下一步：继续补齐当前状态中仍然缺失、且对现状判断有影响的事实。'
      : '下一步：进入目标架构设计，重点处理目前尚未闭合的 ' + (openQuestions.length ? '问题和 ' + String(openQuestions.length) + ' 个待确认事项' : '范围') + '。',
    '',
    '## 7. 待确认问题',
    '',
    ...(openQuestions.length
      ? openQuestions.map((question) => '- ' + question)
      : ['当前没有记录需要业务方直接回答的问题；这不代表所有信息都已经确认。']),
    '',
    '## 8. 证据与覆盖情况',
    '',
    'SQL：' + sqlCoverage,
    '数据集血缘：' + connectedDatasets + ' 已建立结构连接；这不等于已经确认业务上的权威来源。',
    '列级血缘：' + String(columnEdges) + ' 条',
    '数据质量画像：' + String(snapshot?.profiles.length ?? 0) + ' 个数据集',
    'Evidence：' + String(inv.evidence.length) + ' 条',
    'Findings：' + String(inv.findings.length) + ' 个；Claims：' + String(inv.claims.length) + ' 个；Unknowns：' + String(inv.unknowns.length) + ' 个',
    '',
  ];

  if (modernization && !currentStateOnly) {
    lines.push(
      '## 9. Modernization 状态',
      '',
      modernization.targetArchitecture.components.length
        ? '目标架构已经有 ' + String(modernization.targetArchitecture.components.length) + ' 个组件草案。'
        : '目标架构还没有形成实际组件。',
      modernization.mappings.length
        ? '已经记录 ' + String(modernization.mappings.length) + ' 条新旧对应关系。'
        : '还没有记录新旧数据对应关系。',
      '验证检查：' + String(modernization.validationPlan.checks.length) + ' 项。',
      '',
    );
  }

  const markdown = lines.join('\n');
  const dir = reportsDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, 'report.md');
  await fs.writeFile(fp, markdown + '\\n', 'utf8');
  return { markdown, path: fp };
}
