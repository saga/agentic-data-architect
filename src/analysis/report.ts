/**
 * Investigation 最终报告生成器。
 *
 * 这里把已经保存的调查结果整理成人可以直接阅读的报告。
 * 它不改变事实，只改变事实的选择、组织和表达方式。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import type { Investigation } from '../investigation/store.js';
import { assertInvestigationReportGate } from '../workflow/report-gate.js';
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

async function listAnalysisArtifacts(name: string): Promise<string[]> {
  const root = path.join(path.dirname(reportsDir(name)), 'artifacts');
  async function walk(dir: string, relative = ''): Promise<string[]> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: string[] = [];
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) result.push(...await walk(child, childRelative));
      else if (entry.isFile()) result.push(childRelative);
    }
    return result;
  }
  return walk(root);
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

/**
 * Investigation Report（用户阅读版）。
 *
 * 正式报告先讲清结果；完整 Evidence、原始 lineage 和分析文件继续保存在工作区。
 */
export async function buildReport(
  name: string,
  source?: {
    investigation: Investigation;
    snapshot: DiscoverySnapshot | null;
    modernization?: Awaited<ReturnType<typeof loadModernizationPlan>> | null;
  },
): Promise<{ markdown: string; path: string }> {

  const inv = source?.investigation ?? await loadInvestigation(name);
  const snapshot = source?.snapshot ?? await loadLatestSnapshot<DiscoverySnapshot>(name);
  const modernization = source
    ? source.modernization ?? null
    : await loadModernizationPlan(name);
  const analysisArtifacts = await listAnalysisArtifacts(name);
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
  const datasetFlows = estate ? summarizeDatasetFlows(estate) : [];
  const sqlTransforms = estate ? summarizeSqlTransforms(estate) : [];

  const lines: string[] = [
    '# 调查报告：' + inv.name,
    '',
    '## 先说结论',
    '',
    inv.mission?.expectedResult
      ? '这次调查要解决的是：' + inv.mission.purpose
      : '**用户目标**：' + (inv.userPrompt || inv.goal || '未记录'),
    '',
    inv.mission?.expectedResult
      ? '最后希望拿到：' + inv.mission.expectedResult
      : '',
    '',
    coverage
      ? '目前已经查到 ' + String(coverage.datasets) + ' 个数据集，' + String(sqlFiles.length)
        + ' 个 SQL 文件；SQL 解析失败 ' + String(sqlParseFailures) + ' 个。'
      : '目前没有形成数据发现快照，这份报告主要根据已经保存的调查结果整理。',
    '',
    inv.claims.length
      ? '已经形成 ' + String(inv.claims.length) + ' 条关键结论。'
      : '目前还没有单独保存的关键结论。',
    inv.findings.length
      ? '已经记录 ' + String(inv.findings.length) + ' 个需要注意的问题。'
      : '目前没有记录需要单独处理的问题。',
    '',
    '## 这次查到了什么',
    '',
    ...(inv.systems.length
      ? ['涉及的系统：' + preview(inv.systems, 8), '']
      : []),
    ...(inv.scope.length
      ? ['这次重点看的范围：' + preview(inv.scope, 8), '']
      : []),
    ...(datasets.length
      ? ['已经找到的数据集：' + preview(datasets, 12), '']
      : []),
    ...(datasetFlows.length
      ? ['### 关键数据流', '', ...datasetFlows.map((item) => '- ' + item), '']
      : ['### 关键数据流', '', '目前还没有形成可以直接解释的上下游关系。', '']),
    ...(sqlTransforms.length
      ? ['### 关键转换', '', ...sqlTransforms.map((item) => '- ' + item), '']
      : []),
    '## 已经确认的结论',
    '',
    ...(inv.claims.length
      ? inv.claims.slice(0, 12).flatMap((claim) => [
          '### ' + claimStatusText(claim.status),
          '',
          claim.claim.split('\n')[0].trim(),
          claim.evidenceIds.length ? '资料编号：' + claim.evidenceIds.slice(0, 3).join('、') : '',
          '',
        ])
      : ['目前还没有形成单独保存的关键结论。', '']),
    '## 需要注意的问题',
    '',
    ...(inv.findings.length
      ? inv.findings.slice(0, 10).flatMap((finding) => [
          '### ' + finding.title,
          '',
          finding.description,
          '',
          '为什么要注意：' + impactForFinding(finding.type),
          finding.affectedAssets.length ? '涉及对象：' + preview(finding.affectedAssets, 5) : '',
          finding.evidenceIds.length ? '资料编号：' + finding.evidenceIds.slice(0, 3).join('、') : '',
          '',
        ])
      : ['目前没有记录需要单独处理的问题。', '']),
    '## 还不能确认',
    '',
    ...(openQuestions.length
      ? openQuestions.map((question) => '- ' + question)
      : ['目前没有记录需要用户直接回答的事项；这不代表所有信息都已经确认。']),
    '',
  ];
  if (current && !currentStateOnly) {
    lines.push(
      '## 数据检查情况',
      '',
      'SQL 文件：' + sqlCoverage + '。',
      '数据集上下游连接：' + connectedDatasets + '。',
      '列级数据关系：' + String(columnEdges) + ' 条。',
      '已经做过数据画像的数据集：' + String(snapshot?.profiles.length ?? 0) + ' 个。',
      '',
    );
  }

  if (modernization && !currentStateOnly) {
    lines.push(
      '## 改造工作进展',
      '',
      modernization.targetArchitecture.components.length
        ? '目标架构目前有 ' + String(modernization.targetArchitecture.components.length) + ' 个组件草案。'
        : '目标架构还没有形成实际组件。',
      modernization.mappings.length
        ? '已经记录 ' + String(modernization.mappings.length) + ' 条新旧对应关系。'
        : '还没有记录新旧数据对应关系。',
      '验证检查目前有 ' + String(modernization.validationPlan.checks.length) + ' 项。',
      '',
    );
  }

  lines.push('## 调查过程中留下的资料', '');
  if (analysisArtifacts.length) {
    lines.push(...analysisArtifacts.slice(0, 30).map((item) => '- ' + item));
  } else {
    lines.push('- 目前没有额外的分析文件。');
  }
  lines.push(
    '',
    '## 下一步',
    inv.workflow === 'current-data-architecture'
      ? '如果还要继续调查，就优先补齐那些会影响当前架构理解的未确认事项。'
      : '如果还要继续工作，就优先处理上面已经明确会影响结果的问题；不要为了把所有未知项清零而无限调查。',
    '',
    '## 资料依据',
    '',
    '这份报告使用了本次 Investigation 已保存的调查资料、数据发现和分析文件。具体资料编号可在对应记录中回看。',
    '本报告只表达已经保存的结果；不能确认的内容会保留为未确认，不会为了完整而补猜。',
    '',
  );

  const markdown = lines.join('\n');
  const dir = reportsDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, 'report.md');
  await fs.writeFile(fp, markdown + '\\n', 'utf8');
  return { markdown, path: fp };
}
