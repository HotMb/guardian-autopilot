import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-mcp-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import {used} from './used'; void used;\n");
  await writeFile(join(root, 'src', 'used.ts'), 'export const used = true;\n');
  return root;
}

function startServer(root) {
  const child = spawn(process.execPath, [cli, 'mcp'], {
    cwd: root,
    env: {...process.env, CLEANCODE_MCP_ROOT: root},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = createInterface({input: child.stdout, crlfDelay: Infinity});
  return {child, responses: output[Symbol.asyncIterator]()};
}

async function request(server, message) {
  server.child.stdin.write(`${JSON.stringify(message)}\n`);
  const next = await server.responses.next();
  assert.equal(next.done, false);
  return JSON.parse(next.value);
}

test('CleanCode MCP exposes only read-only analysis tools', async () => {
  const root = await fixture();
  const server = startServer(root);
  try {
    const initialized = await request(server, {jsonrpc: '2.0', id: 1, method: 'initialize'});
    assert.equal(initialized.result.serverInfo.name, 'cleancode-mcp');
    const listed = await request(server, {jsonrpc: '2.0', id: 2, method: 'tools/list'});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['discover', 'analyze', 'plan', 'report']);
    for (const tool of listed.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
    }
    const report = await request(server, {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'report', arguments: {format: 'json'}}});
    assert.equal(JSON.parse(report.result.content[0].text).mode, 'read-only');
  } finally {
    server.child.stdin.end();
    await once(server.child, 'close');
  }
});

test('CleanCode MCP rejects outside roots and destructive tools', async () => {
  const root = await fixture();
  const server = startServer(root);
  try {
    const outside = await request(server, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'discover', arguments: {root: '..'}}});
    assert.equal(outside.result.isError, true);
    assert.match(outside.result.content[0].text, /inside CLEANCODE_MCP_ROOT/);
    const destructive = await request(server, {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'apply', arguments: {}}});
    assert.equal(destructive.result.isError, true);
    assert.match(destructive.result.content[0].text, /Unknown tool/);
  } finally {
    server.child.stdin.end();
    await once(server.child, 'close');
  }
});
