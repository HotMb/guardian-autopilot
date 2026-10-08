import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/next-app/', import.meta.url));

function startServer(root = fixtureRoot) {
  const child = spawn(process.execPath, [cli, 'mcp'], {
    cwd: root,
    env: {...process.env, GUARDIAN_MCP_ROOT: root},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = createInterface({input: child.stdout, crlfDelay: Infinity});
  const responses = output[Symbol.asyncIterator]();
  return {child, responses};
}

async function request(server, message) {
  server.child.stdin.write(`${JSON.stringify(message)}\n`);
  return nextResponse(server);
}

async function nextResponse(server) {
  const next = await server.responses.next();
  assert.equal(next.done, false);
  return JSON.parse(next.value);
}

test('MCP stdio adapter lists and calls read-only Guardian tools', async () => {
  const server = startServer();
  try {
    const initialized = await request(server, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}});
    assert.equal(initialized.result.serverInfo.name, 'guardian-autopilot');

    const listed = await request(server, {jsonrpc: '2.0', id: 2, method: 'tools/list'});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['guardian_scan', 'guardian_references', 'guardian_plan']);

    const called = await request(server, {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'guardian_plan', arguments: {}}});
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.structuredContent.mode, 'read-only');
  } finally {
    server.child.stdin.end();
    await once(server.child, 'close');
  }
});

test('MCP adapter rejects roots outside its configured project', async () => {
  const server = startServer();
  try {
    const response = await request(server, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'guardian_scan', arguments: {root: '..'}}});
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /inside GUARDIAN_MCP_ROOT/);
  } finally {
    server.child.stdin.end();
    await once(server.child, 'close');
  }
});

test('MCP adapter returns JSON-RPC errors for malformed and unknown requests', async () => {
  const server = startServer();
  try {
    server.child.stdin.write('not-json\n');
    const parseError = await nextResponse(server);
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    const invalidRequest = await request(server, {jsonrpc: '1.0', id: 5, method: 'ping'});
    assert.equal(invalidRequest.error.code, -32600);

    const unknownMethod = await request(server, {jsonrpc: '2.0', id: 6, method: 'completion/complete'});
    assert.equal(unknownMethod.error.code, -32601);

    const missingTool = await request(server, {jsonrpc: '2.0', id: 7, method: 'tools/call', params: {}});
    assert.equal(missingTool.error.code, -32602);

    const unknownTool = await request(server, {jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'guardian_cleanup', arguments: {}}});
    assert.equal(unknownTool.result.isError, true);
    assert.match(unknownTool.result.content[0].text, /Unknown tool/);
  } finally {
    server.child.stdin.end();
    await once(server.child, 'close');
  }
});

test('MCP adapter does not answer notifications', async () => {
  const server = startServer();
  try {
    server.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized', params: {}})}\n`);
    const response = await request(server, {jsonrpc: '2.0', id: 10, method: 'ping'});
    assert.deepEqual(response, {jsonrpc: '2.0', id: 10, result: {}});
  } finally {
    server.child.stdin.end();
    await once(server.child, 'close');
  }
});

test('MCP adapter rejects a symlinked child root that resolves outside the project', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'guardian-mcp-project-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'guardian-mcp-outside-'));
  const linkPath = join(projectRoot, 'linked-outside');
  try {
    await mkdir(join(outsideRoot, 'nested'));
    try {
      await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symbolic links are unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const server = startServer(projectRoot);
    try {
      const response = await request(server, {jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'guardian_scan', arguments: {root: 'linked-outside'}}});
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /inside GUARDIAN_MCP_ROOT/);
    } finally {
      server.child.stdin.end();
      await once(server.child, 'close');
    }
  } finally {
    await rm(projectRoot, {recursive: true, force: true});
    await rm(outsideRoot, {recursive: true, force: true});
  }
});
