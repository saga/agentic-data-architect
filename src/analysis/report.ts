/**
 * Current-State Report 生成器。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import type { DiscoverySnapshot } from '../workflow/discover.js';

/**
 * Current-State Report（§二十）：8 节，带 Coverage / Gaps。
 * 写到 reports/report.md，同时 stdout 打印。
 */
export async function buildReport(name: string): Promise<{ markdown: string; path: string }> {
  const inv = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  const lineage = snapshot?.lineage ?? null;
  const estate = snapshot?.estate ?? null;

  const edges = lineage?.edges ?? [];
  const tables = (lineage?.tables ?? []).filter((t) => !t.startsWith('file:'));
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source.toLowerCase());
    connected.add(e.target.toLowerCase());
  }
  const evidenceByType = new Map<string, number>();
  for (const e of inv.evidence) evidenceByType.set(e.type, (evidenceByType.get(e.type) ?? 0) + 1);

  const sqlFiles = snapshot?.inventory?.files.filter((f) => f.kind === 'sql') ?? [];
  const parsedFiles = new Set((lineage?.statements ?? []).map((s) => s.file));
  const sqlCoverage = sqlFiles.length === 0 ? 'n/a (no sql files)' : `${parsedFiles.size}/${sqlFiles.length}`;
  const lineageCoverage =
    tables.length === 0 ? 'n/a' : `${connected.size}/${tables.length} datasets connected`;
  const columnEdges = lineage?.columns.length ?? 0;

  const L = [
    `# Current-State Report: ${inv.name}`,
    ``,
    `> Evidence-first：每条结论回指 evidence id。状态只有 verified / supported / inferred / unknown / contradicted。`,
    ``,
    `## 1. Scope`,
    ``,
    `- Goal: ${inv.goal || '(unset)'}`,
    `- Scope: ${inv.scope.join(', ') || '(unset)'}`,
    `- Systems: ${inv.systems.join(', ') || '(unset)'}`,
    `- Discovery runs: ${inv.discoveryRuns.map((r) => `${r.id} (${r.root}, parser=${r.parserVersion})`).join('; ') || '(none)'}`,
    ``,
    `## 2. Data Estate`,
    ``,
    `- Nodes: ${estate?.nodes.length ?? 0}, Edges: ${estate?.edges.length ?? 0}`,
    `- Datasets: ${tables.join(', ') || '(none)'}`,
    ``,
    `## 3. Dependency / Lineage`,
    ``,
    ...(edges.length ? edges.map((e) => `- ${e.source} → ${e.target} [${e.evidenceId}]`) : ['(no edges)']),
    ...(columnEdges ? [``, `Column lineage edges: ${columnEdges}`] : []),
    ``,
    `## 4. Findings`,
    ``,
    ...(inv.findings.length
      ? inv.findings.map((f) => `- [${f.severity}/${f.status}] ${f.type}: ${f.title} — ${f.description.slice(0, 200)}`)
      : ['(none — run discover to generate deterministic findings)']),
    ``,
    `## 5. Current-State Intelligence`,
    ``,
    ...(snapshot?.currentState
      ? [
        `- Dataset lineage coverage: ${snapshot.currentState.coverage.datasetLineageCoverage === null ? 'n/a' : (snapshot.currentState.coverage.datasetLineageCoverage * 100).toFixed(1) + '%'}`,
        `- SQL parse failures: ${snapshot.currentState.coverage.sqlParseFailures}`,
        `- Semantic assets: ${snapshot.currentState.coverage.semanticAssets}`,
        `- Source-of-truth candidates: ${snapshot.currentState.sourceOfTruthCandidates.length}`,
        `- Semantic candidates: ${snapshot.currentState.semanticCandidates.length}`,
      ]
      : ['(no Current-State Intelligence yet)']),
    ``,
    `## 6. Data Quality`,
    ``,
    ...((snapshot?.profiles.length ?? 0)
      ? (snapshot?.profiles ?? []).map((p) => `- ${p.dataset}: rows=${p.rowCount}`)
      : ['(no DB profiling yet — discover with --database ... --profile)']),
    ``,
    `## 6. Open Questions`,
    ``,
    ...(inv.unknowns.length ? inv.unknowns.map((u) => `- ${u}`) : ['(none)']),
    ``,
    `## 7. Evidence-backed Claims`,
    ``,
    ...(inv.claims.length
      ? inv.claims.map((c) => `### [${c.status}] ${c.claim.split('\n')[0]?.slice(0, 160)}` + `\n evidence: ${c.evidenceIds.join(', ') || '(none → treat as unknown)'}`)
      : ['(none yet — run ask)']),
    ``,
    `## 8. Coverage / Gaps`,
    ``,
    `- SQL parse coverage: ${sqlCoverage}`,
    `- Lineage coverage: ${lineageCoverage}`,
    `- Column lineage edges: ${columnEdges}`,
    `- Evidence: ${inv.evidence.length} total (${[...evidenceByType.entries()].map(([t, n]) => `${t}=${n}`).join(', ') || 'none'})`,
    `- Findings: ${inv.findings.length}, Claims: ${inv.claims.length}, Unknowns: ${inv.unknowns.length}`,
  ];
  const markdown = L.join('\n');
  const dir = reportsDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, 'report.md');
  await fs.writeFile(fp, markdown);
  return { markdown, path: fp };
}
