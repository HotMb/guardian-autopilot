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
  ...sourceExtensions, '.json', '.jsonc', '.md', '.mdx', '.txt', '.html', '.htm', '.css', '.scss', '.less',
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

function tokenOccurs(line: string, token: string): boolean {
  if (token.includes('/')) return line.includes(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_$])${escaped}($|[^\\p{L}\\p{N}_$])`, 'u').test(line);
}

export async function scanStringReferences(rootDir: string, knownFiles: readonly string[]): Promise<StringReferenceReport> {
  const insensitive = process.platform === 'win32';
  const files = [...new Set(knownFiles.map(portable))].sort();
  const targets = files.filter((path) => sourceExtensions.has(extname(path).toLowerCase()));
  const contents = new Map<string, string>();
  const unreadableFiles: string[] = [];

  for (const path of files) {
    if (!textExtensions.has(extname(path).toLowerCase())) continue;
    try {
      contents.set(path, await readFile(resolve(rootDir, path), 'utf8'));
    } catch {
      unreadableFiles.push(path);
    }
  }

  const references: StringReference[] = [];
  for (const target of targets) {
    const tokens = referenceTokens(target).map((token) => insensitive ? token.toLowerCase() : token);
    for (const [source, content] of contents) {
      if (source === target) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = insensitive ? lines[index]!.toLowerCase() : lines[index]!;
        const matchedIndex = tokens.findIndex((token) => tokenOccurs(line, token));
        if (matchedIndex >= 0) references.push({target, source, line: index + 1, matched: tokens[matchedIndex]!});
      }
    }
  }

  references.sort((left, right) => left.target.localeCompare(right.target) || left.source.localeCompare(right.source) || left.line - right.line);
  return {references, unreadableFiles: unreadableFiles.sort(), noMatchIsProof: false};
}
