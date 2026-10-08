import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || '';
const expected = `v${packageJson.version}`;

if (tag !== expected) {
  throw new Error(`Release tag must match package version exactly: expected ${expected}, received ${tag || '(empty)'}`);
}

console.log(`Release tag verified: ${tag}`);
