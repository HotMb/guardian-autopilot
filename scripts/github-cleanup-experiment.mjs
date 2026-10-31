import {execFile} from 'node:child_process';
import {lstat, realpath, writeFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const sha = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const options = process.argv.slice(2);
const allowedOptions = new Set(['--target', '--candidate', '--checks', '--head', '--output']);

function parseArguments() {
  const result = {};
  for (let index = 0; index < options.length;) {
    const key = options[index];
    if (key === '--allow-preparation') {
      if (result[key]) throw new Error('Duplicate preparation approval');
      result[key] = true;
      index += 1;
      continue;
    }
    const value = options[index + 1];
    if (!allowedOptions.has(key) || !value || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error('Invalid experiment arguments');
    result[key] = value;
    index += 2;
  }
  if ([...allowedOptions].some((key) => !result[key])) throw new Error('Missing experiment arguments');
  return result;
}

function safeRelative(value) {
  return !isAbsolute(value) && !value.includes('\\') && !value.startsWith('-')
    && !/[\x00-\x1f\x7f]/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function git(root, ...args) {
  return exec('git', ['-C', root, ...args], {windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 30_000});
}

async function main() {
  const args = parseArguments();
  if (!sha.test(args['--head']) || !safeRelative(args['--candidate']) || !safeRelative(args['--checks'])) throw new Error('Invalid commit or repository path');
  const candidateKey = process.platform === 'win32' ? args['--candidate'].toLowerCase() : args['--candidate'];
  const checksKey = process.platform === 'win32' ? args['--checks'].toLowerCase() : args['--checks'];
  if (candidateKey === checksKey) throw new Error('The verification file cannot be the cleanup candidate');
  const target = await realpath(resolve(args['--target']));
  const output = await realpath(resolve(args['--output']));
  if (inside(target, output)) throw new Error('Output directory must be outside the target repository');
  const checksPath = resolve(target, args['--checks']);
  if (!(await lstat(checksPath)).isFile() || !inside(target, await realpath(checksPath))) throw new Error('Verification file must be a regular file within the repository');
  await git(target, 'ls-files', '--error-unmatch', '--', args['--checks']);
  const head = (await git(target, 'rev-parse', 'HEAD')).stdout.trim();
  if (head.toLowerCase() !== args['--head'].toLowerCase()) throw new Error('Requested commit does not match the checkout');

  let result;
  try {
    const child = await exec(process.execPath, [cli, 'experiment', target, '--path', args['--candidate'], '--verification-file', checksPath, '--expected-head', head, '--format=json', ...(args['--allow-preparation'] ? ['--allow-preparation'] : [])], {
      timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true,
    });
    result = JSON.parse(child.stdout);
  } catch {
    throw new Error('Experiment or verification failed; no review patch was published');
  }
  if (result.state !== 'COMMITTED' || result.verification?.allPassed !== true || !sha.test(result.commit ?? '')
      || !Array.isArray(result.changedPaths) || result.changedPaths.length !== 1 || result.changedPaths[0] !== args['--candidate']) throw new Error('Experiment result is invalid');
  const parents = (await git(target, 'rev-list', '--parents', '-n', '1', result.commit)).stdout.trim().split(/\s+/);
  if (parents.length !== 2 || parents[1].toLowerCase() !== head.toLowerCase()) throw new Error('Review commit does not match the requested base');
  const changes = (await git(target, 'diff', '--name-status', '-z', '--no-renames', head, result.commit, '--')).stdout.split('\0').filter(Boolean);
  if (changes.length !== 2 || changes[0] !== 'D' || changes[1] !== args['--candidate']) throw new Error('Review commit contains unexpected changes');
  if ((await git(target, 'rev-parse', 'HEAD')).stdout.trim() !== head || (await git(target, 'status', '--porcelain=v1', '--untracked-files=all')).stdout.trim() !== '') throw new Error('Target checkout changed during verification');
  const patch = (await git(target, 'diff', '--binary', '--no-ext-diff', '--no-renames', head, result.commit, '--')).stdout;
  if (patch.trim() === '') throw new Error('Review patch is empty');
  const report = {baseCommit: head, candidate: args['--candidate'], reviewCommit: result.commit, verified: true,
    note: 'Review experiment only. Passing checks do not prove that removal is safe; inspect the patch and external usage before applying it.'};
  await writeFile(resolve(output, 'cleanup.patch'), patch, {flag: 'wx'});
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
  console.log('Review patch created. The original checkout was not changed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Hosted experiment failed');
  process.exitCode = 1;
});
