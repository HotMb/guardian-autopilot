import {createInterface} from 'node:readline';
import {realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {planCandidates} from './candidates.js';
import {findAssetReferences} from './references.js';
import {scan} from './scanner.js';

const protocolVersion = '2025-06-18';
const serverVersion = '0.1.0';

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

const tools = [
  {
    name: 'guardian_scan',
    description: 'Run a read-only asset scan for the configured project or a child directory.',
    inputSchema: {type: 'object', properties: {root: {type: 'string', description: 'Relative project subdirectory; defaults to the configured root.'}}, additionalProperties: false},
  },
  {
    name: 'guardian_references',
    description: 'Resolve supported local asset references without changing files.',
    inputSchema: {type: 'object', properties: {root: {type: 'string', description: 'Relative project subdirectory; defaults to the configured root.'}}, additionalProperties: false},
  },
  {
    name: 'guardian_plan',
    description: 'Produce explainable review-only cleanup candidates without changing files.',
    inputSchema: {type: 'object', properties: {root: {type: 'string', description: 'Relative project subdirectory; defaults to the configured root.'}}, additionalProperties: false},
  },
];

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id: string | number | null | undefined, code: number, message: string): void {
  write({jsonrpc: '2.0', id: id ?? null, error: {code, message}});
}

function configuredRoot(): string {
  return resolve(process.env.GUARDIAN_MCP_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

async function requestedRoot(params: unknown): Promise<string> {
  const raw = params && typeof params === 'object' && !Array.isArray(params) && typeof (params as {root?: unknown}).root === 'string'
    ? (params as {root: string}).root
    : '.';
  const base = configuredRoot();
  const candidate = resolve(base, raw);
  const outside = relative(base, candidate).replaceAll('\\', '/');
  if (outside === '..' || outside.startsWith('../') || isAbsolute(outside)) {
    throw new Error('Requested root must stay inside GUARDIAN_MCP_ROOT');
  }
  const [realBase, realCandidate] = await Promise.all([realpath(base), realpath(candidate)]);
  const realOutside = relative(realBase, realCandidate).replaceAll('\\', '/');
  if (realOutside === '..' || realOutside.startsWith('../') || isAbsolute(realOutside)) {
    throw new Error('Requested root must stay inside GUARDIAN_MCP_ROOT');
  }
  return realCandidate;
}

function toolResult(value: unknown) {
  return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
}

async function callTool(name: string, params: unknown) {
  const root = await requestedRoot(params);
  if (name === 'guardian_scan') return toolResult(await scan(root));
  if (name === 'guardian_references') return toolResult(await findAssetReferences(root));
  if (name === 'guardian_plan') return toolResult(await planCandidates(root));
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    errorResponse(request.id, -32600, 'Invalid JSON-RPC request');
    return;
  }
  const id = request.id;
  if (id === undefined && request.method.startsWith('notifications/')) return;
  if (request.method === 'ping') {
    write({jsonrpc: '2.0', id, result: {}});
    return;
  }
  if (request.method === 'initialize') {
    write({jsonrpc: '2.0', id, result: {
      protocolVersion,
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: 'guardian-autopilot', version: serverVersion},
    }});
    return;
  }
  if (request.method === 'tools/list') {
    write({jsonrpc: '2.0', id, result: {tools}});
    return;
  }
  if (request.method === 'tools/call') {
    const params = request.params as {name?: unknown; arguments?: unknown} | undefined;
    if (!params || typeof params.name !== 'string') {
      errorResponse(id, -32602, 'tools/call requires a tool name');
      return;
    }
    try {
      write({jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments)});
    } catch (error) {
      write({jsonrpc: '2.0', id, result: {isError: true, content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}]}});
    }
    return;
  }
  if (request.method === 'resources/list' || request.method === 'prompts/list') {
    write({jsonrpc: '2.0', id, result: request.method === 'resources/list' ? {resources: []} : {prompts: []}});
    return;
  }
  errorResponse(id, -32601, `Method not found: ${request.method}`);
}

export async function serveMcp(): Promise<void> {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    if (line.length > 4 * 1024 * 1024) {
      errorResponse(null, -32600, 'MCP message exceeds the 4 MiB limit');
      continue;
    }
    try {
      await handle(JSON.parse(line) as JsonRpcRequest);
    } catch (error) {
      errorResponse(null, -32700, error instanceof Error ? error.message : String(error));
    }
  }
}
