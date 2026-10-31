import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createServer} from 'node:http';
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

test('webhook CLI starts for GitHub-only beta deployments without Stripe secrets', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const env = {...process.env, HOST: '127.0.0.1', PORT: String(port)};
  for (const key of Object.keys(env)) if (/^(?:STRIPE|GITHUB|DATABASE)_/.test(key)) delete env[key];
  const child = spawn(process.execPath, [cli, 'webhook'], {env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    let health;
    const deadline = Date.now() + 10_000;
    while (health === undefined && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`webhook CLI exited before becoming healthy: ${stderr}`);
      try { health = await fetch(`http://127.0.0.1:${port}/healthz`); } catch {}
      if (health === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(health, `webhook CLI did not become healthy: ${stderr}`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {ok: true, service: 'guardian-autopilot'});

    const billing = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {method: 'POST', body: '{}'});
    assert.equal(billing.status, 503);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
