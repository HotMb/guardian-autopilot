import {createHash} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {lstat, readFile} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve} from 'node:path';
import {promisify} from 'node:util';
import * as ts from 'typescript';
import type {Evidence} from '@cleancode/shared/types';
import {createVerifiedPositiveProofEvidence, getPositiveProofBinding, type PositiveProofBinding} from './proof-evidence.js';
import {buildManifest, discoverRepository, type RepositoryManifest} from './manifest.js';
import {loadRepositoryConfig} from './repository-config.js';
import {isProtectedPath} from './safeguards.js';

const execFile = promisify(execFileCallback);
export const CLOSED_WORLD_ANALYZER = 'guardian-closed-world-node-application';
export const CLOSED_WORLD_ANALYZER_VERSION = 1;

const runtimeExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const candidateExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const unsupportedRuntimeExtensions = new Set(['.jsx', '.tsx', '.vue', '.svelte', '.astro', '.mdx', '.html', '.htm']);
const configFilePattern = /(?:^|\/)[^/]+\.config\.[^/]+$/i;
const configBasenames = new Set(['angular.json', 'project.json', 'workspace.json', 'lerna.json', 'turbo.json', 'webpack.config', 'vite.config', 'rollup.config', 'next.config', 'nuxt.config', 'astro.config']);
const unsupportedTaskExtensions = new Set(['.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.py', '.pyw']);
const safeNodeBuiltins = new Set([
  'assert', 'assert/strict', 'buffer', 'crypto', 'events', 'path', 'querystring',
  'string_decoder', 'timers', 'url', 'util', 'zlib',
]);
const reflectivePropertyNames = new Set([
  'constructor', '__proto__', 'prototype',
  'getPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors',
  'getOwnPropertyNames', 'getOwnPropertySymbols', 'setPrototypeOf',
  'defineProperty', 'defineProperties', '__lookupGetter__', '__lookupSetter__',
  '__defineGetter__', '__defineSetter__',
]);
const reflectionApiNames = new Set([
  'getPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors',
  'getOwnPropertyNames', 'getOwnPropertySymbols', 'setPrototypeOf',
  'defineProperty', 'defineProperties', '__lookupGetter__', '__lookupSetter__',
  '__defineGetter__', '__defineSetter__',
]);
const loaderPropertyNames = new Set([
  '_load', 'mainModule', 'binding', 'dlopen', 'getBuiltinModule', 'createRequire',
]);
const typeScriptConfigAllowedOptions = new Set([
  'target', 'module', 'moduleResolution', 'strict', 'skipLibCheck', 'allowJs', 'checkJs', 'noEmit',
  'declaration', 'sourceMap', 'esModuleInterop', 'forceConsistentCasingInFileNames', 'resolveJsonModule',
]);
const packageFieldsAllowed = new Set([
  'name', 'private', 'version', 'type', 'dependencies', 'devDependencies', 'optionalDependencies',
  'peerDependencies', 'engines', 'description', 'license', 'author', 'repository', 'homepage', 'bugs',
]);

export type ClosedWorldBlocker = {code: string; message: string; path?: string};

export type ClosedWorldAnalysis = {
  analyzer: string;
  analyzerVersion: number;
  root: string;
  complete: boolean;
  roots: string[];
  reachable: string[];
  unreachable: string[];
  blockers: ClosedWorldBlocker[];
  proofs: ReadonlyMap<string, Evidence>;
};

type RuntimeEdge = {from: string; to: string};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonDigest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function cleanPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function sourceKind(file: string): ts.ScriptKind {
  switch (extname(file).toLowerCase()) {
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function addBlocker(blockers: ClosedWorldBlocker[], code: string, message: string, path?: string): void {
  blockers.push({code, message, ...(path === undefined ? {} : {path})});
}

function dedupeBlockers(blockers: ClosedWorldBlocker[]): ClosedWorldBlocker[] {
  const unique = new Map<string, ClosedWorldBlocker>();
  for (const blocker of blockers) unique.set(`${blocker.code}\0${blocker.path ?? ''}\0${blocker.message}`, blocker);
  return [...unique.values()].sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', root, ...args], {windowsHide: true, maxBuffer: 2 * 1024 * 1024});
  return result.stdout.trim();
}

async function gitBytes(root: string, args: string[]): Promise<Buffer> {
  const result = await execFile('git', ['-C', root, ...args], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer',
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

function normalizeTextLineEndings(bytes: Buffer): Buffer {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes;
  return Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8');
}

type GitSnapshotFile = {blob: string};

async function establishGitSnapshot(root: string, manifest: RepositoryManifest, blockers: ClosedWorldBlocker[]): Promise<Map<string, GitSnapshotFile>> {
  const tree = await gitBytes(root, ['ls-tree', '-r', '--full-tree', '-z', 'HEAD']);
  const blobs = new Map<string, string>();
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    if (separator < 0) {
      addBlocker(blockers, 'git-tree-invalid', 'Git returned a malformed tree entry.');
      continue;
    }
    const metadata = entry.slice(0, separator).split(' ');
    const path = cleanPath(entry.slice(separator + 1));
    if (metadata[1] !== 'blob' || !/^[a-f0-9]{40,64}$/i.test(metadata[2] ?? '')) {
      addBlocker(blockers, 'unsupported-git-entry', `Snapshot entry is not a regular Git blob: ${path}`, path);
      continue;
    }
    blobs.set(path, metadata[2].toLowerCase());
  }

  const snapshot = new Map<string, GitSnapshotFile>();
  for (const file of manifest.files) {
    const blob = blobs.get(file.path);
    if (blob === undefined) {
      addBlocker(blockers, 'untracked-snapshot-file', 'Every file visible to the closed-world analyzer must be tracked by the clean Git snapshot.', file.path);
      continue;
    }
    snapshot.set(file.path, {blob});
  }
  return snapshot;
}

async function checkCleanHead(root: string, blockers: ClosedWorldBlocker[]): Promise<string | undefined> {
  try {
    const status = await gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status !== '') addBlocker(blockers, 'dirty-git-tree', 'Git working tree is not clean; proof requires a clean snapshot.');
    const head = await gitOutput(root, ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/i.test(head)) {
      addBlocker(blockers, 'invalid-git-head', 'Git HEAD is not a full commit hash.');
      return undefined;
    }
    return head.toLowerCase();
  } catch (error) {
    addBlocker(blockers, 'git-check-failed', `Cannot establish a clean Git HEAD: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function validatePackageBoundary(root: string, manifest: RepositoryManifest, blockers: ClosedWorldBlocker[]): Promise<string | undefined> {
  const packageFiles = manifest.files.filter((file) => file.path.split('/').at(-1)?.toLowerCase() === 'package.json');
  const nested = packageFiles.filter((file) => file.path !== 'package.json');
  for (const file of nested) addBlocker(blockers, 'nested-package-boundary', 'Nested package boundaries can publish or load files outside the application graph.', file.path);
  const packageFile = manifest.files.find((file) => file.path === 'package.json');
  if (packageFile === undefined) {
    addBlocker(blockers, 'package-boundary-missing', 'The Node application profile requires a tracked root package.json.');
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(root, packageFile.path), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json must contain an object');
    const value = parsed as Record<string, unknown>;
    if (value.private !== true) addBlocker(blockers, 'package-not-private', 'The root package must set private=true; published packages are outside this proof profile.', packageFile.path);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (!Object.hasOwn(value, field)) continue;
      const entries = value[field];
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
        addBlocker(blockers, 'unsupported-package-dependencies', `package.json ${field} must be omitted or an empty object; external packages are not modeled.`, packageFile.path);
      } else if (Object.keys(entries as Record<string, unknown>).length > 0) {
        addBlocker(blockers, 'unsupported-package-dependencies', `Non-empty package.json ${field} may load first-party files through plugins or resolvers; this profile requires it to be empty.`, packageFile.path);
      }
    }
    for (const field of ['exports', 'main', 'module', 'browser', 'bin', 'types', 'typings', 'files', 'workspaces', 'imports']) {
      if (Object.hasOwn(value, field)) addBlocker(blockers, 'published-or-aliased-package', `package.json field ${field} creates an entrypoint, publication boundary, workspace, or alias this profile does not model.`, packageFile.path);
    }
    if (value.scripts !== undefined) {
      if (value.scripts === null || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) {
        addBlocker(blockers, 'unsupported-package-scripts', 'package.json scripts must be omitted; script-defined runtime roots are not modeled.', packageFile.path);
      } else if (Object.keys(value.scripts as Record<string, unknown>).length > 0) {
        addBlocker(blockers, 'unsupported-package-scripts', 'Non-empty package.json scripts may declare additional runtime roots; this profile requires them to be omitted.', packageFile.path);
      }
    }
    for (const field of Object.keys(value)) {
      if (!packageFieldsAllowed.has(field) && field !== 'scripts' && !['exports', 'main', 'module', 'browser', 'bin', 'types', 'typings', 'files', 'workspaces', 'imports'].includes(field)) {
        addBlocker(blockers, 'unsupported-package-config', `package.json field ${field} is outside the closed-world profile.`, packageFile.path);
      }
    }
    if (typeof value.name === 'string' && value.name.trim() !== '') return value.name;
  } catch (error) {
    addBlocker(blockers, 'package-json-invalid', `Cannot parse root package.json: ${error instanceof Error ? error.message : String(error)}`, packageFile.path);
  }
  return undefined;
}

async function validateSourceConfiguration(root: string, manifest: RepositoryManifest, blockers: ClosedWorldBlocker[]): Promise<void> {
  for (const file of manifest.files) {
    const base = file.path.split('/').at(-1)?.toLowerCase() ?? '';
    if (unsupportedTaskExtensions.has(extname(base)) || /^(?:makefile|justfile|taskfile(?:\.ya?ml)?|dockerfile)$/i.test(base)
      || file.path.toLowerCase().startsWith('.github/workflows/')) {
      addBlocker(blockers, 'unsupported-command-root', 'Shell, batch, PowerShell, Python, task-runner, Docker, or workflow commands may launch runtime code outside the declared source graph.', file.path);
      continue;
    }
    const withoutExtension = base.replace(/\.[^.]+$/, '');
    if (configFilePattern.test(file.path) || configBasenames.has(base) || configBasenames.has(withoutExtension) || /^\.(?:babelrc|eslintrc|prettierrc|swcrc)(?:\.|$)/i.test(base)) {
      addBlocker(blockers, 'unsupported-source-config', 'Framework, bundler, plugin, or tool configuration may declare runtime roots or loaders outside this profile.', file.path);
      continue;
    }
    if (/^(?:ts|js)config(?:\..+)?\.json$/i.test(base) && base !== 'tsconfig.json' && base !== 'jsconfig.json') {
      addBlocker(blockers, 'unsupported-source-config', `Configuration variant ${base} is not modeled by this profile.`, file.path);
      continue;
    }
    if (base !== 'tsconfig.json' && base !== 'jsconfig.json') continue;
    try {
      const filePath = resolve(root, file.path);
      const source = await readFile(filePath, 'utf8');
      const parsed = ts.parseConfigFileTextToJson(filePath, source);
      if (parsed.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
      if (parsed.config === null || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) throw new Error('configuration must be an object');
      const config = parsed.config as Record<string, unknown>;
      for (const key of Object.keys(config)) {
        if (!['compilerOptions', 'include', 'exclude', 'files'].includes(key)) throw new Error(`unsupported top-level option ${key}`);
      }
      const options = config.compilerOptions;
      if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) throw new Error('compilerOptions must be an object');
      for (const key of Object.keys((options ?? {}) as Record<string, unknown>)) {
        if (!typeScriptConfigAllowedOptions.has(key)) throw new Error(`unsupported compiler option ${key}`);
      }
      for (const key of ['include', 'exclude', 'files']) {
        const items = config[key];
        if (items !== undefined && (!Array.isArray(items) || items.some((item) => typeof item !== 'string'))) throw new Error(`${key} must be a string array`);
      }
    } catch (error) {
      addBlocker(blockers, 'unsupported-source-config', `Unsupported ${base}: ${error instanceof Error ? error.message : String(error)}`, file.path);
    }
  }
}

function literalSpecifier(value: ts.Expression | undefined): value is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return value !== undefined && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value));
}

function moduleSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  return undefined;
}

function constantStringProperty(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
    return constantStringProperty(expression.expression);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantStringProperty(expression.left);
    const right = constantStringProperty(expression.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const part = constantStringProperty(span.expression);
      if (part === undefined) return undefined;
      value += `${part}${span.literal.text}`;
    }
    return value;
  }
  return undefined;
}

function dynamicOrReflectiveMarker(node: ts.Node): string | undefined {
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return 'import.meta';
  if (ts.isIdentifier(node) && ['eval', 'Function', 'Proxy', 'Reflect', 'createRequire', '__non_webpack_require__', 'Worker', 'SharedWorker', 'importScripts', 'Bun', 'Deno'].includes(node.text)) return node.text;
  // These ambient roots can expose loaders or runtime state through aliases. This
  // profile deliberately rejects all use instead of attempting incomplete taint tracking.
  if (ts.isIdentifier(node) && ['process', 'global', 'globalThis', 'window', 'self', 'arguments'].includes(node.text)) return `ambient runtime root ${node.text}`;
  if (ts.isIdentifier(node) && reflectionApiNames.has(node.text)) return `aliased reflection API ${node.text}`;
  if (ts.isIdentifier(node) && loaderPropertyNames.has(node.text)) return `loader API reference ${node.text}`;
  if (ts.isIdentifier(node) && node.text === 'require') {
    const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
    if (!directCall) return 'aliased or reflected require';
  }
  if (ts.isIdentifier(node) && node.text === 'module') return 'Node module loader object';
  if (ts.isElementAccessExpression(node)) {
    let base: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
    if (ts.isIdentifier(base) && ['module', 'require', 'process', 'global', 'globalThis'].includes(base.text)) return `computed loader access via ${base.text}[...]`;
    const property = constantStringProperty(node.argumentExpression);
    if (property !== undefined && reflectivePropertyNames.has(property)) return `computed reflective property access ${JSON.stringify(property)}`;
    if (property !== undefined && reflectionApiNames.has(property)) return `computed reflection API access ${JSON.stringify(property)}`;
    if (property !== undefined && loaderPropertyNames.has(property)) return `computed loader API access ${JSON.stringify(property)}`;
    if (node.argumentExpression !== undefined && !ts.isNumericLiteral(node.argumentExpression)) return 'unresolved computed property access';
    if (node.argumentExpression === undefined) return 'unresolved computed property access';
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (reflectivePropertyNames.has(node.name.text)) return `reflective property access .${node.name.text}`;
    const chain: string[] = [];
    let current: ts.Expression = node;
    while (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text);
      current = current.expression;
    }
    if (ts.isIdentifier(current)) chain.unshift(current.text);
    const full = chain.join('.');
    if (/^Object\.(?:getPrototypeOf|getOwnPropertyDescriptor|getOwnPropertyDescriptors|getOwnPropertyNames|getOwnPropertySymbols|setPrototypeOf|defineProperty|defineProperties)$/i.test(full)) return `reflection API ${full}`;
    if (/^(?:(?:global|globalThis)\.(?:require|module|Function|eval|process)|process\.(?:mainModule|binding|dlopen|getBuiltinModule)|Module\._load|vm\.(?:runIn|compileFunction|SourceTextModule))/i.test(full)) return full;
    if (/(?:glob|plugin|loadModule|importModule|resolveModule)$/i.test(full)) return full;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /(?:plugin|glob|requireFrom|importModule|loadModule)/i.test(node.expression.text)) return node.expression.text;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const called = node.expression.name.text;
    if (/^(?:spawn|exec|fork|Worker|runInContext|runInNewContext|runInThisContext|compileFunction|createRequire|dlopen)$/i.test(called)) return `loader call ${called}`;
  }
  return undefined;
}

function forbiddenRuntimeModule(specifier: string): boolean {
  return /^(?:node:)?(?:child_process|worker_threads|workerpool|cluster|vm|module|inspector|node:inspector|node:vm|node:module|node:child_process|node:worker_threads)$/i.test(specifier);
}

function resolveLocalEdge(root: string, from: string, specifier: string, knownFiles: Set<string>, blockers: ClosedWorldBlocker[]): string | undefined {
  if (!specifier.startsWith('.')) {
    if (specifier.startsWith('#')) {
      addBlocker(blockers, 'package-import-alias', `Package import aliases are not modeled: ${specifier}`, from);
    } else if (!specifier.startsWith('node:') || !safeNodeBuiltins.has(specifier.slice('node:'.length))) {
      addBlocker(blockers, 'unsupported-external-module', `External module is outside the allowlisted safe Node built-ins: ${specifier}`, from);
    }
    return undefined;
  }
  const absoluteTarget = resolve(dirname(resolve(root, from)), specifier);
  const path = cleanPath(relative(root, absoluteTarget));
  if (path === '' || path === '..' || path.startsWith('../') || isAbsolute(path)) {
    addBlocker(blockers, 'local-edge-escapes-root', `Local module reference escapes the repository: ${specifier}`, from);
    return undefined;
  }
  const extension = extname(path).toLowerCase();
  if (!runtimeExtensions.has(extension)) {
    addBlocker(blockers, 'unsupported-local-edge', `Local reference must target an explicit JavaScript or TypeScript file: ${specifier}`, from);
    return undefined;
  }
  if (!knownFiles.has(path)) {
    addBlocker(blockers, 'unresolved-local-edge', `Local module reference does not resolve to a discovered file: ${specifier}`, from);
    return undefined;
  }
  return path;
}

async function buildClosedWorldGraph(root: string, manifest: RepositoryManifest, packageName: string | undefined, blockers: ClosedWorldBlocker[]): Promise<RuntimeEdge[]> {
  const files = new Set(manifest.files.map((file) => file.path));
  const sources = manifest.files.filter((file) => runtimeExtensions.has(extname(file.path).toLowerCase()));
  for (const file of manifest.files) {
    const extension = extname(file.path).toLowerCase();
    if (unsupportedRuntimeExtensions.has(extension)) addBlocker(blockers, 'unsupported-runtime-source', `Runtime or template source ${extension} is not modeled by this analyzer.`, file.path);
    if (/\.d\.(?:ts|mts|cts)$/i.test(file.path)) continue;
  }
  const edges: RuntimeEdge[] = [];
  for (const file of sources) {
    if (/\.d\.(?:ts|mts|cts)$/i.test(file.path)) continue;
    let source: string;
    try { source = await readFile(resolve(root, file.path), 'utf8'); }
    catch (error) {
      addBlocker(blockers, 'source-read-failed', `Cannot read source file: ${error instanceof Error ? error.message : String(error)}`, file.path);
      continue;
    }
    const sourceFile = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, sourceKind(file.path));
    for (const diagnostic of (sourceFile as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics) {
      const position = diagnostic.start === undefined ? '' : ` at offset ${diagnostic.start}`;
      addBlocker(blockers, 'source-parse-failed', `Source parse failed${position}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`, file.path);
    }
    function visit(node: ts.Node): void {
      const marker = dynamicOrReflectiveMarker(node);
      if (marker !== undefined) addBlocker(blockers, 'dynamic-or-reflective-loader', `Unsupported dynamic, reflective, plugin, or glob loader pattern: ${marker}`, file.path);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addBlocker(blockers, 'dynamic-import', 'Dynamic import is not modeled, even when its argument is a string literal.', file.path);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          if (node.arguments.length !== 1 || !literalSpecifier(node.arguments[0])) {
            addBlocker(blockers, 'dynamic-require', 'require() must have exactly one literal module specifier.', file.path);
          } else {
            if (forbiddenRuntimeModule(node.arguments[0].text)) addBlocker(blockers, 'forbidden-loader-module', `Node code-loading module is outside this profile: ${node.arguments[0].text}`, file.path);
            const target = resolveLocalEdge(root, file.path, node.arguments[0].text, files, blockers);
            if (target !== undefined) edges.push({from: file.path, to: target});
          }
        }
      }
      const specifier = moduleSpecifier(node);
      if (specifier !== undefined) {
        if (!literalSpecifier(specifier)) {
          addBlocker(blockers, 'nonliteral-module-specifier', 'Module declarations must use literal specifiers.', file.path);
        } else {
          const value = specifier.text;
          if (forbiddenRuntimeModule(value)) addBlocker(blockers, 'forbidden-loader-module', `Node code-loading module is outside this profile: ${value}`, file.path);
          if (packageName !== undefined && (value === packageName || value.startsWith(`${packageName}/`))) {
            addBlocker(blockers, 'package-self-reference', `Package self-reference is not modeled: ${value}`, file.path);
          } else {
            const target = resolveLocalEdge(root, file.path, value, files, blockers);
            if (target !== undefined) edges.push({from: file.path, to: target});
          }
        }
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        const target = resolveLocalEdge(root, file.path, node.argument.literal.text, files, blockers);
        if (target !== undefined) edges.push({from: file.path, to: target});
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return edges;
}

function buildProofBinding(input: Omit<PositiveProofBinding, 'bindingDigest'>): PositiveProofBinding {
  return {...input, bindingDigest: jsonDigest(input)};
}

function blockedAnalysis(root: string, blockers: ClosedWorldBlocker[]): ClosedWorldAnalysis {
  return {
    analyzer: CLOSED_WORLD_ANALYZER,
    analyzerVersion: CLOSED_WORLD_ANALYZER_VERSION,
    root,
    complete: false,
    roots: [],
    reachable: [],
    unreachable: [],
    blockers: dedupeBlockers(blockers),
    proofs: new Map(),
  };
}

/**
 * Conservative, opt-in proof for private Node applications with a complete,
 * explicitly declared runtime-root list. A blocked analysis never emits proof.
 */
export async function analyzeClosedWorld(rootDir: string, selectedPaths?: readonly string[]): Promise<ClosedWorldAnalysis> {
  const root = resolve(rootDir);
  const blockers: ClosedWorldBlocker[] = [];
  try {
    const repositoryConfig = await loadRepositoryConfig(root);
    const closedWorld = repositoryConfig.closedWorld;
    if (closedWorld === undefined) {
      addBlocker(blockers, 'closed-world-not-configured', 'Opt in with .guardian/config.json closedWorld profile, explicit entryFiles, and all-runtime-roots-declared commitment.');
      return blockedAnalysis(root, blockers);
    }

    let discovery;
    try { discovery = await discoverRepository(root, {symlinks: 'error'}); }
    catch (error) {
      addBlocker(blockers, 'repository-discovery-failed', `Repository discovery stopped: ${error instanceof Error ? error.message : String(error)}`);
      return blockedAnalysis(root, blockers);
    }
    if (discovery.errors.length > 0) {
      for (const error of discovery.errors) addBlocker(blockers, 'repository-discovery-failed', error.message, error.path);
      return blockedAnalysis(root, blockers);
    }
    let manifest: RepositoryManifest;
    try { manifest = await buildManifest(root, {symlinks: 'error'}); }
    catch (error) {
      addBlocker(blockers, 'manifest-failed', `Cannot hash the complete supported snapshot: ${error instanceof Error ? error.message : String(error)}`);
      return blockedAnalysis(root, blockers);
    }
    const head = await checkCleanHead(root, blockers);
    const gitSnapshot = await establishGitSnapshot(root, manifest, blockers);
    const packageName = await validatePackageBoundary(root, manifest, blockers);
    await validateSourceConfiguration(root, manifest, blockers);

    const sourcePaths = new Set(manifest.files.filter((file) => runtimeExtensions.has(extname(file.path).toLowerCase())).map((file) => file.path));
    const roots = [...closedWorld.entryFiles].sort();
    for (const entry of roots) {
      if (!sourcePaths.has(entry)) addBlocker(blockers, 'runtime-root-missing', `Declared runtime root is missing or is not a supported source file: ${entry}`, entry);
    }
    const configPath = resolve(root, '.guardian/config.json');
    try {
      const trackedConfig = await gitOutput(root, ['ls-files', '--error-unmatch', '--', '.guardian/config.json']);
      if (trackedConfig !== '.guardian/config.json') addBlocker(blockers, 'closed-world-config-untracked', 'The closed-world commitment must be tracked by clean Git HEAD.');
      const configInfo = await lstat(configPath);
      if (!configInfo.isFile() || configInfo.isSymbolicLink()) addBlocker(blockers, 'closed-world-config-unsafe', 'Closed-world configuration must be a regular tracked file.', '.guardian/config.json');
    } catch (error) {
      addBlocker(blockers, 'closed-world-config-untracked', `Cannot verify tracked closed-world configuration: ${error instanceof Error ? error.message : String(error)}`, '.guardian/config.json');
    }
    const edges = await buildClosedWorldGraph(root, manifest, packageName, blockers);
    if (blockers.length > 0 || head === undefined) return blockedAnalysis(root, blockers);

    const sourceDigests = new Map<string, string>();
    for (const file of manifest.files) {
      if (!runtimeExtensions.has(extname(file.path).toLowerCase())) continue;
      try {
        sourceDigests.set(file.path, sha256(normalizeTextLineEndings(await readFile(resolve(root, file.path)))));
      } catch (error) {
        addBlocker(blockers, 'source-read-failed', `Cannot hash source file at proof binding: ${error instanceof Error ? error.message : String(error)}`, file.path);
      }
    }
    const finalHead = await checkCleanHead(root, blockers);
    if (finalHead !== head) addBlocker(blockers, 'snapshot-changed-during-analysis', 'Git HEAD changed while closed-world analysis was running.');
    if (blockers.length > 0) return blockedAnalysis(root, blockers);

    const outgoing = new Map<string, string[]>();
    for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    const reachable = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const path = pending.pop() as string;
      if (reachable.has(path)) continue;
      reachable.add(path);
      pending.push(...(outgoing.get(path) ?? []));
    }
    const unreachable = manifest.files
      .filter((file) => candidateExtensions.has(extname(file.path).toLowerCase()) && !/\.d\.(?:ts|mts|cts)$/i.test(file.path) && !reachable.has(file.path))
      .map((file) => file.path)
      .sort();
    const selected = selectedPaths === undefined ? new Set(unreachable) : new Set(selectedPaths.map(cleanPath));
    const manifestDigest = jsonDigest(manifest.files.map(({path}) => ({
      path,
      gitBlob: gitSnapshot.get(path)?.blob,
      ...(sourceDigests.has(path) ? {sourceSha256: sourceDigests.get(path)} : {}),
    })));
    const configHash = sha256(normalizeTextLineEndings(await readFile(configPath)));
    const proofDigests = sourceDigests;
    const proofs = new Map<string, Evidence>();
    for (const path of [...selected].sort()) {
      if (!unreachable.includes(path)) continue;
      const digest = proofDigests.get(path);
      if (digest === undefined || isProtectedPath(path) || repositoryConfig.protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`))) continue;
      const binding = buildProofBinding({
        analyzer: CLOSED_WORLD_ANALYZER,
        analyzerVersion: CLOSED_WORLD_ANALYZER_VERSION,
        candidatePath: path,
        candidateSha256: digest,
        repositoryHead: head,
        configSha256: configHash,
        manifestSha256: manifestDigest,
        roots,
      });
      proofs.set(path, createVerifiedPositiveProofEvidence(
        `Closed-world unreachable: ${CLOSED_WORLD_ANALYZER} v${CLOSED_WORLD_ANALYZER_VERSION}; snapshot ${binding.bindingDigest.slice(0, 16)}`,
        0.99,
        binding,
      ));
    }
    return {
      analyzer: CLOSED_WORLD_ANALYZER,
      analyzerVersion: CLOSED_WORLD_ANALYZER_VERSION,
      root,
      complete: true,
      roots,
      reachable: [...reachable].sort(),
      unreachable,
      blockers: [],
      proofs,
    };
  } catch (error) {
    addBlocker(blockers, 'closed-world-analysis-failed', `Analysis stopped without proof: ${error instanceof Error ? error.message : String(error)}`);
    return blockedAnalysis(root, blockers);
  }
}

/** Re-run the trusted analyzer and compare every immutable proof binding. */
export async function validateClosedWorldProof(rootDir: string, candidatePath: string, evidence: Evidence): Promise<void> {
  const binding = getPositiveProofBinding(evidence);
  if (binding === undefined) throw new Error('Engine-verified positive proof is missing its immutable closed-world snapshot binding');
  const normalized = cleanPath(candidatePath);
  if (normalized !== binding.candidatePath) throw new Error(`Positive proof path does not match candidate path: ${candidatePath}`);
  const fresh = await analyzeClosedWorld(rootDir, [normalized]);
  const currentEvidence = fresh.proofs.get(normalized);
  const current = currentEvidence === undefined ? undefined : getPositiveProofBinding(currentEvidence);
  if (!fresh.complete || current === undefined) {
    const reason = fresh.blockers.map((item) => `${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`).join('; ');
    throw new Error(`Closed-world proof could not be revalidated${reason ? `: ${reason}` : ''}`);
  }
  if (JSON.stringify(current) !== JSON.stringify(binding)) throw new Error(`Closed-world proof is stale for ${normalized}; repository, configuration, roots, manifest, or candidate changed`);
}
