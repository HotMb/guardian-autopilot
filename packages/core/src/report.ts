import type {PlanReport} from './planner.js';

export type ReportFormat = 'json' | 'markdown' | 'html';

export type CleanCodeReport = {
  schemaVersion: 1;
  mode: 'read-only';
  root: string;
  filesScanned: number;
  resolvedReferences: number;
  unresolvedReferences: number;
  duplicateGroups: number;
  candidates: Array<{
    path: string;
    kind: string;
    confidence: number;
    allowed: boolean;
    reasons: string[];
    sameAs?: string;
  }>;
  knip: {
    status: string;
    issues: number;
    error?: string;
  };
};

function summary(plan: PlanReport): CleanCodeReport {
  return {
    schemaVersion: 1,
    mode: 'read-only',
    root: plan.root,
    filesScanned: plan.manifest.files.length,
    resolvedReferences: plan.graph.edges.length,
    unresolvedReferences: plan.graph.unresolved.length,
    duplicateGroups: plan.duplicates.length,
    candidates: plan.candidates.map((candidate) => ({
      path: candidate.path,
      kind: candidate.kind,
      confidence: candidate.decision.confidence,
      allowed: candidate.decision.allowed,
      reasons: [...candidate.decision.reasons],
      ...(candidate.sameAs === undefined ? {} : {sameAs: candidate.sameAs}),
    })),
    knip: {
      status: plan.knip.status,
      issues: plan.knip.issues.length,
      ...(plan.knip.error === undefined ? {} : {error: plan.knip.error}),
    },
  };
}

function markdown(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ');
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderMarkdown(report: CleanCodeReport): string {
  const rows = report.candidates.length === 0
    ? '| _none_ | — | — | — |\n'
    : report.candidates.map((candidate) => `| ${markdown(candidate.path)} | ${markdown(candidate.kind)} | ${candidate.confidence.toFixed(2)} | ${candidate.allowed ? 'eligible' : 'blocked'} |`).join('\n') + '\n';
  return [
    '# CleanCode report',
    '',
    `- Root: \`${markdown(report.root)}\``,
    `- Files scanned: ${report.filesScanned}`,
    `- References: ${report.resolvedReferences} resolved, ${report.unresolvedReferences} unresolved`,
    `- Exact duplicate groups: ${report.duplicateGroups}`,
    `- Knip: ${report.knip.status} (${report.knip.issues} issues)`,
    '',
    '## Candidates',
    '',
    '| Path | Kind | Confidence | Decision |',
    '| --- | --- | ---: | --- |',
    rows.trimEnd(),
    '',
    'This report is read-only. A candidate is never applied without explicit positive proof and guarded verification.',
    '',
  ].join('\n');
}

function renderHtml(report: CleanCodeReport): string {
  const rows = report.candidates.length === 0
    ? '<tr><td colspan="4">none</td></tr>'
    : report.candidates.map((candidate) => `<tr><td>${html(candidate.path)}</td><td>${html(candidate.kind)}</td><td>${candidate.confidence.toFixed(2)}</td><td>${candidate.allowed ? 'eligible' : 'blocked'}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CleanCode report</title></head>
<body><main><h1>CleanCode report</h1>
<dl><dt>Root</dt><dd>${html(report.root)}</dd><dt>Files scanned</dt><dd>${report.filesScanned}</dd><dt>References</dt><dd>${report.resolvedReferences} resolved, ${report.unresolvedReferences} unresolved</dd><dt>Knip</dt><dd>${html(report.knip.status)} (${report.knip.issues} issues)</dd></dl>
<h2>Candidates</h2><table><thead><tr><th>Path</th><th>Kind</th><th>Confidence</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table>
<p>This report is read-only. A candidate is never applied without explicit positive proof and guarded verification.</p></main></body></html>
`;
}

export function renderReport(plan: PlanReport, format: ReportFormat): string {
  const report = summary(plan);
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'html') return renderHtml(report);
  return renderMarkdown(report);
}
