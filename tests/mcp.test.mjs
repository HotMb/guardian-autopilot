import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/next-app/', import.meta.url));

function startServer() {
  const child = spawn(process.execPath, [cli, 'mcp'], {
    cwd: fixtureRoot,
    env: {...process.env, GUARDIAN_MCP_ROOT: fixtureRoot},
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
