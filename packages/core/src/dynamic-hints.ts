import {readFile} from 'node:fs/promises';
import {extname, relative, resolve} from 'node:path';
import {discoverRepository} from './manifest.js';

export type DynamicHintKind = 'dynamic-require' | 'dynamic-import' | 'reflective-container' | 'dependency-injection' | 'serialization';

export type DynamicHint = {
  path: string;
  line: number;
  kind: DynamicHintKind;
  marker: string;
  confidence: 0.5;
};

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const patterns: ReadonlyArray<{kind: DynamicHintKind; pattern: RegExp}> = [
  {kind: 'dynamic-require', pattern: /require\s*\(\s*[`'"]\.\/[^\n]*\$\{/},
  {kind: 'dynamic-import', pattern: /import\s*\(\s*[`'"]\.\/[^\n]*\$\{/},
  {kind: 'reflective-container', pattern: /\.get\s*\(\s*['"][^'"]+['"]\s*\)\s*\(/},
  {kind: 'dependency-injection', pattern: /@(Injectable|Component|Service)\b/},
  {kind: 'serialization', pattern: /@(JsonProperty|SerializedName)\b/g},
];

export async function scanDynamicHints(rootDir: string): Promise<DynamicHint[]> {
  const discovery = await discoverRepository(rootDir);
  const hints: DynamicHint[] = [];
  for (const path of discovery.files) {
    if (!sourceExtensions.has(extname(path).toLowerCase())) continue;
    const content = await readFile(resolve(discovery.root, path), 'utf8');
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
