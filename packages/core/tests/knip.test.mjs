import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

test('normalizes Knip JSON issues without enabling fix mode', async () => {
  const {parseKnipReport} = await import('../dist/knip.js');
  const issues = parseKnipReport({issues: [
    {file: 'src/a.ts', dependencies: [{name: 'unused-lib', line: 2, col: 3}], unlisted: ['missing-lib']},
    {file: 'src/b.ts', unresolved: [{name: './missing'}]},
  ]});

  if (JSON.stringify(issues) !== JSON.stringify([
    {file: 'src/a.ts', type: 'dependencies', name: 'unused-lib', line: 2, col: 3},
    {file: 'src/a.ts', type: 'unlisted', name: 'missing-lib'},
    {file: 'src/b.ts', type: 'unresolved', name: './missing'},
  ])) throw new Error(`Unexpected issues: ${JSON.stringify(issues)}`);
});

test('bounds a hung Knip process and terminates its child process tree', async (t) => {
  if (process.platform === 'win32') {
    const probe = spawnSync('taskkill.exe', ['/PID', '4294967295', '/T', '/F'], {encoding: 'utf8', windowsHide: true});
    if (/mot de passe est incorrect|username or password is incorrect/i.test(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`)) {
      return t.skip('the managed Windows runner denies taskkill process-tree control');
    }
  }
  const {runKnip} = await import('../dist/knip.js');
  const root = await mkdtemp(join(tmpdir(), 'cleancode-knip-timeout-'));
  const executable = join(root, process.platform === 'win32' ? 'knip.cmd' : 'knip');
  const script = join(root, 'slow-knip.js');
  const childPidFile = join(root, 'child.pid');
  try {
    const childScript = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid)); setTimeout(()=>{},30000);`;
    await writeFile(script, childScript);
    if (process.platform === 'win32') {
      await writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
    } else {
      await writeFile(executable, `#!/usr/bin/env node\n${childScript}\n`);
      await chmod(executable, 0o755);
    }
    const startedAt = Date.now();
    const result = await runKnip(root, {executable, timeoutMs: 500});
    assert.equal(result.status, 'failed', result.error);
    assert.match(result.error, /exceeded its 500 ms timeout/i);
    assert.ok(Date.now() - startedAt < 5_000);
    const childPid = Number(await (await import('node:fs/promises')).readFile(childPidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'the fake analyzer must have started its child');
    let childStillRunning = true;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { process.kill(childPid, 0); }
      catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'EINVAL') { childStillRunning = false; break; }
        throw error;
      }
      await delay(50);
    }
    assert.equal(childStillRunning, false, 'timed-out Knip child process must not be left running');
  } finally {
    try {
      const childPid = Number(await (await import('node:fs/promises')).readFile(childPidFile, 'utf8'));
      if (Number.isSafeInteger(childPid) && childPid > 0) process.kill(childPid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
    }
    await rm(root, {recursive: true, force: true});
  }
});

test('planRepository forwards its Knip timeout to the external analysis', async () => {
  const {planRepository} = await import('../dist/planner.js');
  const root = await mkdtemp(join(tmpdir(), 'cleancode-plan-knip-timeout-'));
  const executable = join(root, process.platform === 'win32' ? 'knip.cmd' : 'knip');
  try {
    if (process.platform === 'win32') {
      await writeFile(executable, `@echo off\r\n"${process.execPath}" -e "setTimeout(() => process.exit(0), 3000)"\r\n`);
    } else {
      await writeFile(executable, '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30_000);\n');
      await chmod(executable, 0o755);
    }
    const startedAt = Date.now();
    const report = await planRepository(root, {knipExecutable: executable, knipTimeoutMs: 200});
    assert.equal(report.knip.status, 'failed', report.knip.error);
    assert.match(report.knip.error, /exceeded its 200 ms timeout/i);
    assert.ok(Date.now() - startedAt < 5_000, 'the configured Knip timeout must bound the plan');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('reports missing Knip as unavailable instead of failing the analysis', async () => {
  const {runKnip} = await import('../dist/knip.js');
  const result = await runKnip('.', {executable: 'definitely-not-a-real-knip'});
  if (result.status !== 'unavailable' || result.issues.length !== 0) throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
});

