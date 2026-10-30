import * as ts from 'typescript';
import {readFile} from 'node:fs/promises';
import {extname, relative, resolve} from 'node:path';
import {discoverRepository, type RepositoryManifest} from './manifest.js';
import type {SourceTextCache} from './reference-graph.js';

export type DynamicHintKind = 'dynamic-require' | 'dynamic-import' | 'reflective-container' | 'dependency-injection' | 'serialization' | 'opaque-code-execution' | 'unsupported-syntax';

export type DynamicHint = {
  path: string;
  line: number;
  kind: DynamicHintKind;
  marker: string;
  confidence: 0.5;
};

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const patterns: ReadonlyArray<{kind: DynamicHintKind; pattern: RegExp}> = [
  {kind: 'reflective-container', pattern: /\.get\s*\(\s*['"][^'"]+['"]\s*\)\s*\(/},
  {kind: 'dependency-injection', pattern: /@(Injectable|Component|Service)\b/},
  {kind: 'serialization', pattern: /@(JsonProperty|SerializedName)\b/g},
];

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function staticSpecifier(value: ts.Expression | undefined): boolean {
  return value !== undefined && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value));
}

function isImportMeta(value: ts.Expression): boolean {
  return ts.isMetaProperty(value)
    && value.keywordToken === ts.SyntaxKind.ImportKeyword
    && value.name.text === 'meta';
}

function addAstHints(path: string, content: string, hints: DynamicHint[]): void {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const add = (node: ts.Node, kind: DynamicHintKind): void => {
    const {line} = source.getLineAndCharacterOfPosition(node.getStart(source));
    hints.push({path, line: line + 1, kind, marker: node.getText(source), confidence: 0.5});
  };

  const parseDiagnostics = (source as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0]!;
    const position = diagnostic.start ?? 0;
    const {line} = source.getLineAndCharacterOfPosition(position);
    hints.push({path, line: line + 1, kind: 'unsupported-syntax', marker: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), confidence: 0.5});
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (expression.kind === ts.SyntaxKind.ImportKeyword && !staticSpecifier(node.arguments[0])) add(node, 'dynamic-import');
      else if (ts.isIdentifier(expression) && expression.text === 'require' && !staticSpecifier(node.arguments[0])) add(node, 'dynamic-require');
      else if (ts.isIdentifier(expression) && expression.text === 'createRequire') add(node, 'dynamic-require');
      else if (ts.isIdentifier(expression) && (expression.text === 'eval' || expression.text === 'Function')) add(node, 'opaque-code-execution');
      else if (ts.isPropertyAccessExpression(expression)) {
        const receiver = expression.expression;
        if (ts.isIdentifier(receiver) && receiver.text === 'require' && ['context', 'resolve'].includes(expression.name.text)) add(node, 'dynamic-require');
        else if (ts.isIdentifier(receiver) && receiver.text === 'module' && expression.name.text === 'require') add(node, 'dynamic-require');
        else if (expression.name.text === 'glob' && isImportMeta(receiver)) add(node, 'dynamic-import');
        else if (ts.isIdentifier(receiver) && receiver.text === 'vm' && ['runInContext', 'runInNewContext', 'runInThisContext'].includes(expression.name.text)) add(node, 'opaque-code-execution');
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      add(node, 'opaque-code-execution');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export async function scanDynamicHints(
  rootDir: string,
  manifest?: Pick<RepositoryManifest, 'root' | 'files'>,
  sourceTextCache?: SourceTextCache,
): Promise<DynamicHint[]> {
  const discovery = manifest === undefined
    ? await discoverRepository(rootDir)
    : {root: manifest.root, files: manifest.files.map((file) => file.path)};
  const hints: DynamicHint[] = [];
  for (const path of discovery.files) {
    if (!sourceExtensions.has(extname(path).toLowerCase())) continue;
    let content = sourceTextCache?.get(path);
    if (content === undefined) {
      content = await readFile(resolve(discovery.root, path), 'utf8');
      sourceTextCache?.set(path, content);
    }
    addAstHints(path, content, hints);
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const {kind, pattern} of patterns) {
        const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
        const matches = [...line.matchAll(new RegExp(pattern.source, flags))];
        for (const match of matches) {
          hints.push({
            path: relative(discovery.root, resolve(discovery.root, path)).replaceAll('\\', '/'),
            line: index + 1,
            kind,
            marker: match[0],
            confidence: 0.5,
          });
        }
      }
    });
  }
  return hints.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind) || left.marker.localeCompare(right.marker));
}
