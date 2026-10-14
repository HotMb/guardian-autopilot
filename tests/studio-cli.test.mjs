import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('CLI starts Studio with the selected folder and exposes only local watch metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guardian-studio-cli-watch-'));
  const imagePath = join(root, 'generated.png');
  const imageBytes = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
  const port = await availablePort();
  const child = spawn(process.execPath, ['dist/cli.js', 'studio', '--watch', root], {
    cwd: projectRoot,
    env: {...process.env, GUARDIAN_STUDIO_PORT: String(port)},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await writeFile(imagePath, imageBytes);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Studio CLI did not start: ' + stdout + stderr)), 10_000);
      const onData = () => {
        if (!stdout.includes('Guardian Studio listening locally at')) return;
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        resolve();
      };
      const onExit = (code) => {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        reject(new Error('Studio CLI exited before startup (' + code + '): ' + stdout + stderr));
      };
      child.stdout.on('data', onData);
      child.once('exit', onExit);
    });

    const response = await fetch('http://127.0.0.1:' + port + '/api/watch/status');
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.enabled, true);
    assert.equal(status.folder, basename(root));
    assert.equal(status.imageCount, 1);
    assert.equal(status.largeCount, 1);
    assert.equal(status.candidates[0].path, 'generated.png');
    assert.equal(JSON.stringify(status).includes(root), false);
    assert.deepEqual(await readFile(imagePath), imageBytes);
    assert.deepEqual(await readdir(root), ['generated.png']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    await rm(root, {recursive: true, force: true});
  }
});
