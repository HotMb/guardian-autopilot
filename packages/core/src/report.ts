import type {PlanReport} from './planner.js';
import type {DynamicHint} from './dynamic-hints.js';
import type {CoverageReport} from './coverage.js';
import type {PackageEntrypointReport} from './package-exports.js';
import type {StringReferenceReport} from './string-references.js';

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
  dynamicHints: DynamicHint[];
  coverage: CoverageReport;
  packageEntrypoints: PackageEntrypointReport;
  stringReferences: StringReferenceReport;
  deletionReadiness: {
    status: 'blocked';
    reason: string;
    automatedBlockers: string[];
    humanChecks: string[];
  };
};

const deletionBlockedReason = 'No supported analyzer can currently issue engine-verified positive proof.';
const humanChecks = ['confirm-entrypoints', 'confirm-external-usage'];

function automatedBlockers(plan: PlanReport): string[] {
  const blockers = ['engine-proof-unavailable'];
  if (plan.dynamicHints.length > 0) blockers.push('dynamic-usage-hints');
  if (plan.graph.unresolved.length > 0) blockers.push('unresolved-local-references');
  if (plan.packageEntrypoints.invalidManifests.length > 0) blockers.push('invalid-package-manifest');
  if (plan.stringReferences.unreadableFiles.length > 0) blockers.push('unreadable-reference-scan');
  return blockers;
}

function blockerDescription(id: string): string {
  switch (id) {
    case 'engine-proof-unavailable': return 'No supported analyzer can currently issue engine-verified positive proof.';
    case 'dynamic-usage-hints': return 'Dynamic-loading patterns were detected; the scan is not exhaustive and each hint needs review.';
    case 'unresolved-local-references': return 'One or more local references could not be resolved; candidates cannot be evaluated safely until they are resolved.';
    case 'invalid-package-manifest': return 'One or more package manifests could not be analyzed; package entrypoints may be missing from the scan.';
    case 'unreadable-reference-scan': return 'One or more files could not be scanned for literal references; the scan cannot establish absence of references.';
    default: return id;
  }
}

function humanCheckDescription(id: string): string {
  switch (id) {
    case 'confirm-entrypoints': return 'Confirm every runtime, package, framework, CLI, plugin, and deployment entrypoint is represented.';
    case 'confirm-external-usage': return 'Confirm no external consumer, deployment script, or runtime configuration loads the candidate.';
    default: return id;
  }
}

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
    dynamicHints: plan.dynamicHints,
    coverage: plan.coverage,
    packageEntrypoints: plan.packageEntrypoints,
    stringReferences: plan.stringReferences,
    deletionReadiness: {
      status: 'blocked',
      reason: deletionBlockedReason,
      automatedBlockers: automatedBlockers(plan),
      humanChecks: [...humanChecks],
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
    ? '| _none_ | — | — | — | — |\n'
    : report.candidates.map((candidate) => `| ${markdown(candidate.path)} | ${markdown(candidate.kind)} | ${candidate.confidence.toFixed(2)} | ${candidate.allowed ? 'eligible' : 'blocked'} | ${markdown(candidate.reasons.join('; ') || 'No policy blockers')} |`).join('\n') + '\n';
  const hintRows = report.dynamicHints.length === 0
    ? '_No documented dynamic-usage hints found._'
    : ['| Path | Line | Hint | Marker |', '| --- | ---: | --- | --- |', ...report.dynamicHints.map((hint) => `| ${markdown(hint.path)} | ${hint.line} | ${markdown(hint.kind)} | \`${markdown(hint.marker)}\` |`)].join('\n');
  return [
    '# CleanCode report',
    '',
    `- Root: \`${markdown(report.root)}\``,
    `- Files scanned: ${report.filesScanned}`,
    `- References: ${report.resolvedReferences} resolved, ${report.unresolvedReferences} unresolved`,
    `- Exact duplicate groups: ${report.duplicateGroups}`,
    `- Knip: ${report.knip.status} (${report.knip.issues} issues)`,
    `- Test coverage: ${report.coverage.status}; ${report.coverage.executedFiles.length} file(s) positively observed; ${report.coverage.zeroCoverageFiles.length} file(s) with measured zero hits`,
    `- Package entrypoints: ${report.packageEntrypoints.files.length} protected; ${report.packageEntrypoints.invalidManifests.length} invalid manifest(s)`,
    `- Literal string references: ${report.stringReferences.references.length} hit(s); ${report.stringReferences.unreadableFiles.length} unreadable file(s)`,
    `- Deletion readiness: ${report.deletionReadiness.status} — ${report.deletionReadiness.reason}`,
    '',
    '## Automated blockers',
    '',
    ...report.deletionReadiness.automatedBlockers.map((id) => `- \`${markdown(id)}\`: ${markdown(blockerDescription(id))}`),
    '',
    '## Human validation required',
    '',
    ...report.deletionReadiness.humanChecks.map((id) => `- \`${markdown(id)}\`: ${markdown(humanCheckDescription(id))}`),
    '',
    '## Candidates',
    '',
    '| Path | Kind | Confidence | Decision | Reason |',
    '| --- | --- | ---: | --- | --- |',
    rows.trimEnd(),
    '',
    '## Dynamic-usage hints',
    '',
    hintRows,
    '',
    'Hints are review signals, not proof of use or proof of non-use. Their confidence is intentionally capped at 0.50.',
    '',
    'A file with executed coverage is not proposed for cleanup. Zero coverage is not proof that a file is unused.',
    '',
    'Files declared by package.json entrypoints (exports, bin, main, and related fields) are not proposed for cleanup.',
    '',
    'Literal string matches suppress cleanup candidates; no match is not proof that a file is unused. An unreadable scan input suppresses all candidates.',
    '',
    'This report is read-only. A candidate is never applied without explicit positive proof and guarded verification.',
    '',
    `Deletion readiness is ${report.deletionReadiness.status}: ${report.deletionReadiness.reason}`,
    '',
  ].join('\n');
}

function renderHtml(report: CleanCodeReport): string {
  const rows = report.candidates.length === 0
    ? '<tr><td colspan="5">none</td></tr>'
    : report.candidates.map((candidate) => `<tr><td>${html(candidate.path)}</td><td>${html(candidate.kind)}</td><td>${candidate.confidence.toFixed(2)}</td><td>${candidate.allowed ? 'eligible' : 'blocked'}</td><td>${html(candidate.reasons.join('; ') || 'No policy blockers')}</td></tr>`).join('');
  const hintRows = report.dynamicHints.length === 0
    ? '<tr><td colspan="4">No documented dynamic-usage hints found.</td></tr>'
    : report.dynamicHints.map((hint) => `<tr><td>${html(hint.path)}</td><td>${hint.line}</td><td>${html(hint.kind)}</td><td><code>${html(hint.marker)}</code></td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CleanCode report</title></head>
<body><main><h1>CleanCode report</h1>
<dl><dt>Root</dt><dd>${html(report.root)}</dd><dt>Files scanned</dt><dd>${report.filesScanned}</dd><dt>References</dt><dd>${report.resolvedReferences} resolved, ${report.unresolvedReferences} unresolved</dd><dt>Knip</dt><dd>${html(report.knip.status)} (${report.knip.issues} issues)</dd><dt>Test coverage</dt><dd>${html(report.coverage.status)}; ${report.coverage.executedFiles.length} file(s) positively observed; ${report.coverage.zeroCoverageFiles.length} with measured zero hits</dd><dt>Package entrypoints</dt><dd>${report.packageEntrypoints.files.length} protected; ${report.packageEntrypoints.invalidManifests.length} invalid manifest(s)</dd><dt>Literal string references</dt><dd>${report.stringReferences.references.length} hit(s); ${report.stringReferences.unreadableFiles.length} unreadable file(s)</dd><dt>Deletion readiness</dt><dd>${html(report.deletionReadiness.status)} — ${html(report.deletionReadiness.reason)}</dd></dl>
<h2>Automated blockers</h2><ul>${report.deletionReadiness.automatedBlockers.map((id) => `<li><code>${html(id)}</code>: ${html(blockerDescription(id))}</li>`).join('')}</ul>
<h2>Human validation required</h2><ul>${report.deletionReadiness.humanChecks.map((id) => `<li><code>${html(id)}</code>: ${html(humanCheckDescription(id))}</li>`).join('')}</ul>
<h2>Candidates</h2><table><thead><tr><th>Path</th><th>Kind</th><th>Confidence</th><th>Decision</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Dynamic-usage hints</h2><table><thead><tr><th>Path</th><th>Line</th><th>Hint</th><th>Marker</th></tr></thead><tbody>${hintRows}</tbody></table>
<p>Hints are review signals, not proof of use or proof of non-use. Their confidence is intentionally capped at 0.50.</p>
<p>A file with executed coverage is not proposed for cleanup. Zero coverage is not proof that a file is unused.</p>
<p>Files declared by package.json entrypoints (exports, bin, main, and related fields) are not proposed for cleanup.</p>
<p>Literal string matches suppress cleanup candidates; no match is not proof that a file is unused. An unreadable scan input suppresses all candidates.</p>
<p>Deletion readiness is ${html(report.deletionReadiness.status)}: ${html(report.deletionReadiness.reason)}</p>
<p>This report is read-only. A candidate is never applied without explicit positive proof and guarded verification.</p></main></body></html>
`;
}

export function renderReport(plan: PlanReport, format: ReportFormat): string {
  const report = summary(plan);
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'html') return renderHtml(report);
  return renderMarkdown(report);
}
