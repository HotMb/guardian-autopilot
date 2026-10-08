import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'guardian-cli-test-'));
  await exec('git', ['-C', root, 'init', '--quiet']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Guardian Test']);
  await exec('git', ['-C', root, 'config', 'user.email', 'guardian@example.invalid']);
  return root;
}

async function commitAll(root) {
  await exec('git', ['-C', root, 'add', '--all']);
  await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'initial']);
}

test('cleanup CLI previews by default and applies only with --apply', async () => {
  const root = await makeRepo();
  const file = join(root, 'duplicate.png');
  try {
    await writeFile(file, 'duplicate');
    await commitAll(root);

    const preview = await exec(process.execPath, [cli, 'cleanup', root, 'duplicate.png']);
    assert.equal(JSON.parse(preview.stdout).status, 'dry-run');
    assert.equal(await readFile(file, 'utf8'), 'duplicate');

    const check = JSON.stringify({command: process.execPath, args: ['-e', 'process.exit(0)']});
    const applied = await exec(process.execPath, [cli, 'cleanup', root, '--apply', '--check-json', check, 'duplicate.png']);
    assert.equal(JSON.parse(applied.stdout).status, 'verified');
    assert.equal(JSON.parse(applied.stdout).checks[0].passed, true);
    await assert.rejects(() => readFile(file, 'utf8'));
  } finally { await rm(root, {recursive: true, force: true}); }
});
