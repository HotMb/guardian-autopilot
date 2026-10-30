import {readFile} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';

export type StringReference = {
  target: string;
  source: string;
  line: number;
  matched: string;
};

export type StringReferenceReport = {
  references: StringReference[];
  unreadableFiles: string[];
  noMatchIsProof: false;
};

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const textExtensions = new Set([
  ...sourceExtensions, '.php', '.phtml', '.json', '.jsonc', '.md', '.mdx', '.txt', '.html', '.htm', '.css', '.scss', '.less',
  '.yaml', '.yml', '.toml', '.xml', '.svg', '.sql', '.sh', '.ps1', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
]);

function portable(path: string): string {
  return path.split(sep).join('/').replaceAll('\\', '/');
}

function referenceTokens(target: string): string[] {
  const normalized = portable(target).replace(/^\.\//, '');
  const extension = extname(normalized);
  const withoutExtension = extension ? normalized.slice(0, -extension.length) : normalized;
  const basename = withoutExtension.slice(withoutExtension.lastIndexOf('/') + 1);
  const camel = basename.replace(/[-_]+([a-z\d])/gi, (_match, character: string) => character.toUpperCase());
  const pascal = camel.length === 0 ? camel : `${camel[0]!.toUpperCase()}${camel.slice(1)}`;
  const tokens = [normalized, withoutExtension, basename, camel, pascal];
  if (extension) {
    tokens.push(`./${normalized.slice(normalized.lastIndexOf('/') + 1)}`);
    tokens.push(`./${basename}`);
  }
  return [...new Set(tokens.filter((token) => token.length >= 3))];
}

type TokenEntry = {
  value: string;
  hasPathSeparator: boolean;
  length: number;
  targets: Map<string, number>;
};

type TrieNode = {
  transitions: Map<string, number>;
  failure: number;
  outputs: number[];
};

function buildTokenAutomaton(entries: readonly TokenEntry[]): TrieNode[] {
  const nodes: TrieNode[] = [{transitions: new Map(), failure: 0, outputs: []}];
  for (let tokenIndex = 0; tokenIndex < entries.length; tokenIndex += 1) {
    let state = 0;
    for (const character of entries[tokenIndex]!.value) {
      let next = nodes[state]!.transitions.get(character);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.transitions.set(character, next);
        nodes.push({transitions: new Map(), failure: 0, outputs: []});
      }
      state = next;
    }
    nodes[state]!.outputs.push(tokenIndex);
  }

  const pending: number[] = [];
  for (const child of nodes[0]!.transitions.values()) pending.push(child);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const state = pending[cursor]!;
    for (const [character, next] of nodes[state]!.transitions) {
      pending.push(next);
      let fallback = nodes[state]!.failure;
      while (fallback !== 0 && !nodes[fallback]!.transitions.has(character)) fallback = nodes[fallback]!.failure;
      nodes[next]!.failure = nodes[fallback]!.transitions.get(character) ?? 0;
      nodes[next]!.outputs.push(...nodes[nodes[next]!.failure]!.outputs);
    }
  }
  return nodes;
}

function identifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}_$]$/u.test(value);
}

function scanLine(
  rawLine: string,
  source: string,
  lineNumber: number,
  insensitive: boolean,
  entries: readonly TokenEntry[],
  nodes: readonly TrieNode[],
  references: StringReference[],
): void {
  const characters = Array.from(insensitive ? rawLine.toLowerCase() : rawLine);
  const matches = new Map<string, {priority: number; token: string}>();
  let state = 0;
  for (let end = 0; end < characters.length; end += 1) {
    const character = characters[end]!;
    while (state !== 0 && !nodes[state]!.transitions.has(character)) state = nodes[state]!.failure;
    state = nodes[state]!.transitions.get(character) ?? 0;
    for (const tokenIndex of nodes[state]!.outputs) {
      const entry = entries[tokenIndex]!;
      const start = end - entry.length + 1;
      if (!entry.hasPathSeparator && (identifierCharacter(characters[start - 1]) || identifierCharacter(characters[end + 1]))) continue;
      for (const [target, priority] of entry.targets) {
        if (source === target) continue;
        const current = matches.get(target);
        if (current === undefined || priority < current.priority) matches.set(target, {priority, token: entry.value});
      }
    }
  }
  for (const [target, match] of matches) references.push({target, source, line: lineNumber, matched: match.token});
}

export type StringReferenceProgress = (completed: number, total: number) => void;

export async function scanStringReferences(
  rootDir: string,
  knownFiles: readonly string[],
  additionalTargets: readonly string[] = [],
  onProgress?: StringReferenceProgress,
  sourceTextCache?: ReadonlyMap<string, string>,
): Promise<StringReferenceReport> {
  const insensitive = process.platform === 'win32';
  const files = [...new Set(knownFiles.map(portable))].sort();
  const additionalTargetSet = new Set(additionalTargets.map(portable));
  const targets = files.filter((path) => sourceExtensions.has(extname(path).toLowerCase()) || additionalTargetSet.has(path));
  const tokenByValue = new Map<string, TokenEntry>();
  for (const target of targets) {
    for (const [priority, rawToken] of referenceTokens(target).entries()) {
      const value = insensitive ? rawToken.toLowerCase() : rawToken;
      let entry = tokenByValue.get(value);
      if (entry === undefined) {
        entry = {value, hasPathSeparator: value.includes('/'), length: Array.from(value).length, targets: new Map()};
        tokenByValue.set(value, entry);
      }
      const existing = entry.targets.get(target);
      if (existing === undefined || priority < existing) entry.targets.set(target, priority);
    }
  }
  const tokenEntries = [...tokenByValue.values()];
  const nodes = buildTokenAutomaton(tokenEntries);
  const unreadableFiles: string[] = [];
  const textFiles = files.filter((path) => textExtensions.has(extname(path).toLowerCase()));
  const references: StringReference[] = [];
  const progressInterval = Math.max(1, Math.ceil(textFiles.length / 20));
  const yieldToEventLoop = (): Promise<void> => new Promise((resolveYield) => setImmediate(resolveYield));
  let completed = 0;

  for (const source of textFiles) {
    let content = sourceTextCache?.get(source);
    if (content === undefined) {
      try {
        content = await readFile(resolve(rootDir, source), 'utf8');
      } catch {
        unreadableFiles.push(source);
        completed += 1;
        if (completed % progressInterval === 0 || completed === textFiles.length) onProgress?.(completed, textFiles.length);
        if (completed % 16 === 0) await yieldToEventLoop();
        continue;
      }
    }
    if (source !== undefined) {
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        scanLine(lines[index]!, source, index + 1, insensitive, tokenEntries, nodes, references);
        if ((index + 1) % 4096 === 0) await yieldToEventLoop();
      }
    }
    completed += 1;
    if (completed % progressInterval === 0 || completed === textFiles.length) onProgress?.(completed, textFiles.length);
    if (completed % 16 === 0) await yieldToEventLoop();
  }

  references.sort((left, right) => left.target.localeCompare(right.target) || left.source.localeCompare(right.source) || left.line - right.line);
  return {references, unreadableFiles: unreadableFiles.sort(), noMatchIsProof: false};
}
