import {createInterface} from 'node:readline';
import {realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {buildReferenceGraph, discoverRepository, planRepository, renderReport, type ReportFormat} from '../../core/dist/index.js';

const protocolVersion = '2025-06-18';
const maxMessageBytes = 4 * 1024 * 1024;

type JsonRpcRequest = {jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown};

const tools = [
  {name: 'discover', description: 'Discover repository files and create a manifest.', inputSchema: {type: 'object', properties: {root: {type: 'string'}}}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}},
  {name: 'analyze', description: 'Analyze local references and unresolved targets.', inputSchema: {type: 'object', properties: {root: {type: 'string'}}}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}},
  {name: 'plan', description: 'Generate review-only candidates and confidence decisions.', inputSchema: {type: 'object', properties: {root: {type: 'string'}, minConfidence: {type: 'number'}}}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}},
  {name: 'report', description: 'Generate a read-only JSON, Markdown, or HTML audit report.', inputSchema: {type: 'object', properties: {root: {type: 'string'}, format: {type: 'string', enum: ['json', 'md', 'html']}}}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}},
];

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id: string | number | null | undefined, code: number, message: string): void {
  write({jsonrpc: '2.0', id: id ?? null, error: {code, message}});
}

function configuredRoot(): string {
  return resolve(process.env.CLEANCODE_MCP_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

async function requestedRoot(params: unknown): Promise<string> {
  const raw = params && typeof params === 'object' && !Array.isArray(params) && typeof (params as {root?: unknown}).root === 'string'
    ? (params as {root: string}).root
    : '.';
  const base = configuredRoot();
  const candidate = resolve(base, raw);
  const outside = relative(base, candidate).replaceAll('\\', '/');
  if (outside === '..' || outside.startsWith('../') || isAbsolute(outside)) throw new Error('Requested root must stay inside CLEANCODE_MCP_ROOT');
  const [realBase, realCandidate] = await Promise.all([realpath(base), realpath(candidate)]);
  const realOutside = relative(realBase, realCandidate).replaceAll('\\', '/');
  if (realOutside === '..' || realOutside.startsWith('../') || isAbsolute(realOutside)) throw new Error('Requested root must stay inside CLEANCODE_MCP_ROOT');
  return realCandidate;
}

function toolResult(value: unknown) {
  return {content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}], structuredContent: value};
}

function reportFormat(value: unknown): ReportFormat {
  if (value === 'html') return 'html';
  if (value === 'md' || value === 'markdown') return 'markdown';
  return 'json';
}

async function callTool(name: string, params: unknown) {
  const root = await requestedRoot(params);
  if (name === 'discover') return toolResult({...await discoverRepository(root), mode: 'read-only'});
  if (name === 'analyze') return toolResult({...await buildReferenceGraph(root), mode: 'read-only'});
  if (name === 'plan') {
    const minConfidence = params && typeof params === 'object' && !Array.isArray(params) && typeof (params as {minConfidence?: unknown}).minConfidence === 'number'
      ? (params as {minConfidence: number}).minConfidence
      : undefined;
    return toolResult(await planRepository(root, minConfidence === undefined ? {} : {minConfidence}));
  }
  if (name === 'report') {
    const format = params && typeof params === 'object' && !Array.isArray(params) ? reportFormat((params as {format?: unknown}).format) : 'json';
    return toolResult(renderReport(await planRepository(root), format));
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    errorResponse(request.id, -32600, 'Invalid JSON-RPC request');
    return;
  }
  if (request.id === undefined && request.method.startsWith('notifications/')) return;
  if (request.method === 'ping') { write({jsonrpc: '2.0', id: request.id, result: {}}); return; }
  if (request.method === 'initialize') {
    write({jsonrpc: '2.0', id: request.id, result: {protocolVersion, capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'cleancode-mcp', version: '0.1.0'}}});
    return;
  }
  if (request.method === 'tools/list') { write({jsonrpc: '2.0', id: request.id, result: {tools}}); return; }
  if (request.method === 'tools/call') {
    const params = request.params as {name?: unknown; arguments?: unknown} | undefined;
    if (!params || typeof params.name !== 'string') { errorResponse(request.id, -32602, 'tools/call requires a tool name'); return; }
    try { write({jsonrpc: '2.0', id: request.id, result: await callTool(params.name, params.arguments)}); }
    catch (error) { write({jsonrpc: '2.0', id: request.id, result: {isError: true, content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}]}}); }
    return;
  }
  if (request.method === 'resources/list' || request.method === 'prompts/list') { write({jsonrpc: '2.0', id: request.id, result: request.method === 'resources/list' ? {resources: []} : {prompts: []}}); return; }
  errorResponse(request.id, -32601, `Method not found: ${request.method}`);
}

export async function serveMcp(): Promise<void> {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    if (Buffer.byteLength(line, 'utf8') > maxMessageBytes) { errorResponse(null, -32600, 'MCP message exceeds the 4 MiB limit'); continue; }
    try { await handle(JSON.parse(line) as JsonRpcRequest); }
    catch (error) { errorResponse(null, -32700, error instanceof Error ? error.message : String(error)); }
  }
}
