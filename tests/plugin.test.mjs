import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const pluginRoot = new URL('../integrations/claude-plugin/', import.meta.url);

async function json(relativePath) {
  const text = await readFile(new URL(relativePath, pluginRoot), 'utf8');
  return JSON.parse(text);
}

const hookPath = fileURLToPath(new URL('../integrations/claude-plugin/scripts/post-task.mjs', import.meta.url));

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: env.CLAUDE_PROJECT_DIR,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(input);
  });
}

test('Claude Code plugin has the documented manifest and hook layout', async () => {
  const manifest = await json('.claude-plugin/plugin.json');
  const hooks = await json('hooks/hooks.json');

  assert.equal(manifest.name, 'guardian-autopilot');
  assert.equal(typeof manifest.description, 'string');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(Array.isArray(hooks.hooks.Stop));
  assert.equal(hooks.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'node');
  assert.deepEqual(hooks.hooks.Stop[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/scripts/post-task.mjs']);
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 30);
});

test('Claude Code plugin exposes an explicit read-only audit skill', async () => {
  const skill = await readFile(new URL('skills/audit/SKILL.md', pluginRoot), 'utf8');
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /read-only/i);
  assert.match(skill, /Do not delete, rename, rewrite, or stage files/);
});

test('Claude Code plugin declares the read-only Guardian MCP server', async () => {
  const mcp = await json('.mcp.json');
  assert.equal(mcp.mcpServers.guardian.command, 'guardian');
  assert.deepEqual(mcp.mcpServers.guardian.args, ['mcp']);
  assert.equal(mcp.mcpServers.guardian.env.GUARDIAN_MCP_ROOT, '${CLAUDE_PROJECT_DIR}');
});

test('Claude Code Stop hook runs a read-only plan once and passes the project root', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'guardian-plugin-project-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'guardian-plugin-state-'));
  const fakeRoot = await mkdtemp(join(tmpdir(), 'guardian-plugin-command-'));
  const fakeCommand = join(fakeRoot, 'fake-guardian.mjs');
  const invocationLog = join(fakeRoot, 'invocations.log');
  await writeFile(fakeCommand, String.raw`import {appendFile} from 'node:fs/promises';
await appendFile(process.env.GUARDIAN_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
process.stdout.write(JSON.stringify({candidates: [{id: 'duplicate'}], scanErrors: [], referenceErrors: []}));
`);

  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectRoot,
    GUARDIAN_COMMAND: process.execPath,
    GUARDIAN_COMMAND_ARGS: JSON.stringify([fakeCommand]),
    GUARDIAN_HOOK_STATE_DIR: stateRoot,
    GUARDIAN_HOOK_DEBOUNCE_MS: '300000',
    GUARDIAN_TEST_LOG: invocationLog,
  };

  try {
    const first = await runHook('{}', env);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /Guardian read-only plan: 1 review candidate\. No files were changed\./);
    assert.equal(first.stderr, '');

    const second = await runHook('{}', env);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '');
    assert.equal(second.stderr, '');

    const blocked = await runHook('{"stop_hook_active":true}', env);
    assert.equal(blocked.code, 0);
    assert.equal(blocked.stdout, '');
    assert.equal(blocked.stderr, '');

    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(invocations, [[projectRoot]]);
  } finally {
    await rm(projectRoot, {recursive: true, force: true});
    await rm(stateRoot, {recursive: true, force: true});
    await rm(fakeRoot, {recursive: true, force: true});
  }
});
