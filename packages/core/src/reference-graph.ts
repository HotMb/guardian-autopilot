import * as ts from 'typescript';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, extname, relative, resolve} from 'node:path';
import {discoverRepository, type DiscoveryError, type RepositoryManifest} from './manifest.js';

export type ReferenceKind = 'import' | 'export' | 'dynamic-import' | 'require';

export type ReferenceEdge = {
  from: string;
  to: string;
  specifier: string;
  kind: ReferenceKind;
};

export type UnresolvedReference = {
  from: string;
  specifier: string;
  kind: ReferenceKind;
};

export type SourceTextCache = Map<string, string>;

export type ReferenceGraph = {
  root: string;
  edges: ReferenceEdge[];
  unresolved: UnresolvedReference[];
  errors: DiscoveryError[];
};

type TsConfig = {
  baseUrl?: string;
  paths?: Record<string, string[]>;
};

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const resolutionExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];
const kindOrder: Record<ReferenceKind, number> = {'dynamic-import': 0, import: 1, export: 2, require: 3};

function reportPath(value: string): string {
  return value.replaceAll('\\', '/');
}

async function loadTsConfig(root: string): Promise<TsConfig> {
  try {
    const raw = await readFile(resolve(root, 'tsconfig.json'), 'utf8');
    const parsed = ts.parseConfigFileTextToJson(resolve(root, 'tsconfig.json'), raw).config as {compilerOptions?: TsConfig} | undefined;
    return parsed?.compilerOptions ?? {};
  } catch {
    return {};
  }
}

function aliasTarget(specifier: string, root: string, config: TsConfig): string | undefined {
  for (const [pattern, targets] of Object.entries(config.paths ?? {})) {
    const wildcard = pattern.indexOf('*');
    if (wildcard < 0 && pattern !== specifier) continue;
    if (wildcard >= 0) {
      const prefix = pattern.slice(0, wildcard);
      const suffix = pattern.slice(wildcard + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      const replacement = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
      const target = targets[0];
      if (!target) continue;
      return resolve(root, config.baseUrl ?? '.', target.replace('*', replacement));
    }
    const target = targets[0];
    if (target) return resolve(root, config.baseUrl ?? '.', target);
  }
  return undefined;
}

function isLocalSpecifier(specifier: string, root: string, config: TsConfig): boolean {
  return specifier.startsWith('.') || aliasTarget(specifier, root, config) !== undefined;
}

function resolveFile(candidate: string): string | undefined {
  const candidates = [candidate];
  if (/\.(?:m|c)?js$|\.jsx$/i.test(candidate)) candidates.push(candidate.replace(/\.(?:m|c)?js$|\.jsx$/i, ''));
  for (const base of candidates) {
    for (const extension of resolutionExtensions) {
      const file = `${base}${extension}`;
      if (existsSync(file)) return file;
    }
    for (const extension of resolutionExtensions.slice(1)) {
      const file = resolve(base, `index${extension}`);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

function resolveSpecifier(from: string, specifier: string, root: string, config: TsConfig): string | undefined {
  const base = specifier.startsWith('.') ? resolve(dirname(from), specifier) : aliasTarget(specifier, root, config);
  return base === undefined ? undefined : resolveFile(base);
}

function sourceKind(file: string): ts.ScriptKind {
  switch (extname(file).toLowerCase()) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function staticSpecifier(value: ts.Expression | undefined): value is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return value !== undefined && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value));
}

function referencesInSource(source: string, file: string): Array<{specifier: string; kind: ReferenceKind}> {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file));
  const references: Array<{specifier: string; kind: ReferenceKind}> = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) references.push({specifier: node.moduleSpecifier.text, kind: 'import'});
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) references.push({specifier: node.moduleSpecifier.text, kind: 'export'});
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && staticSpecifier(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) references.push({specifier: node.arguments[0].text, kind: 'dynamic-import'});
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') references.push({specifier: node.arguments[0].text, kind: 'require'});
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return references;
}

export async function buildReferenceGraph(
  rootDir: string,
  manifest?: Pick<RepositoryManifest, 'root' | 'files'> & {errors?: DiscoveryError[]},
  sourceTextCache?: SourceTextCache,
): Promise<ReferenceGraph> {
  const discovery = manifest === undefined
    ? await discoverRepository(rootDir)
    : {root: manifest.root, files: manifest.files.map((file) => file.path), errors: manifest.errors ?? []};
  const root = discovery.root;
  const config = await loadTsConfig(root);
  const edges: ReferenceEdge[] = [];
  const unresolved: UnresolvedReference[] = [];
  const errors: DiscoveryError[] = [...discovery.errors];

  for (const relativeFile of discovery.files) {
    if (!sourceExtensions.has(extname(relativeFile).toLowerCase())) continue;
    const fromAbsolute = resolve(root, relativeFile);
    let source = sourceTextCache?.get(relativeFile);
    try {
      if (source === undefined) {
        source = await readFile(fromAbsolute, 'utf8');
        sourceTextCache?.set(relativeFile, source);
      }
    } catch (error) {
      errors.push({path: reportPath(relative(root, fromAbsolute)), message: error instanceof Error ? error.message : String(error)});
      continue;
    }
    for (const reference of referencesInSource(source, fromAbsolute)) {
      if (!isLocalSpecifier(reference.specifier, root, config)) continue;
      const target = resolveSpecifier(fromAbsolute, reference.specifier, root, config);
      if (target === undefined) {
        unresolved.push({from: reportPath(relative(root, fromAbsolute)), ...reference});
        continue;
      }
      edges.push({
        from: reportPath(relative(root, fromAbsolute)),
        to: reportPath(relative(root, target)),
        ...reference,
      });
    }
  }

  edges.sort((left, right) => left.from.localeCompare(right.from) || kindOrder[left.kind] - kindOrder[right.kind] || left.to.localeCompare(right.to));
  unresolved.sort((left, right) => left.from.localeCompare(right.from) || kindOrder[left.kind] - kindOrder[right.kind] || left.specifier.localeCompare(right.specifier));
  errors.sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
  return {root, edges, unresolved, errors};
}
