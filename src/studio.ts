import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const siteRoot = fileURLToPath(new URL('../site/', import.meta.url));
const assets = new Map<string, {file: string; type: string}>([
  ['/', {file: 'studio.html', type: 'text/html; charset=utf-8'}],
  ['/styles.css', {file: 'styles.css', type: 'text/css; charset=utf-8'}],
  ['/studio.css', {file: 'studio.css', type: 'text/css; charset=utf-8'}],
  ['/studio.js', {file: 'studio.js', type: 'text/javascript; charset=utf-8'}],
  ['/studio-metadata.js', {file: 'studio-metadata.js', type: 'text/javascript; charset=utf-8'}],
  ['/studio-scan.js', {file: 'studio-scan.js', type: 'text/javascript; charset=utf-8'}],
  ['/studio-worker.js', {file: 'studio-worker.js', type: 'text/javascript; charset=utf-8'}],
  ['/studio-file-ops.js', {file: 'studio-file-ops.js', type: 'text/javascript; charset=utf-8'}],
  ['/studio-demo/demo-cabin.png', {file: 'studio-demo/demo-cabin.png', type: 'image/png'}],
  ['/studio-demo/demo-observatory.png', {file: 'studio-demo/demo-observatory.png', type: 'image/png'}],
  ['/studio-demo/demo-explorer.png', {file: 'studio-demo/demo-explorer.png', type: 'image/png'}],
]);

function send(response: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  });
  response.end(body);
}

function expectedHost(server: Server): string | undefined {
  const address = server.address();
  if (!address || typeof address === 'string') return undefined;
  return address.port === 80 ? '127.0.0.1' : `127.0.0.1:${address.port}`;
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const asset = assets.get(pathname);
  if (!asset) {
    send(response, 404, 'Not found');
    return;
  }
  const absolutePath = join(siteRoot, asset.file);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      send(response, 404, 'Not found');
      return;
    }
    const pagePolicy = pathname === '/'
      ? "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    response.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': pagePolicy,
    });
    createReadStream(absolutePath).pipe(response);
  } catch {
    send(response, 404, 'Not found');
  }
}

function handleRequest(server: Server, request: IncomingMessage, response: ServerResponse): void {
  const host = expectedHost(server);
  if (host === undefined || request.headers.host !== host) {
    send(response, 421, 'Misdirected request');
    return;
  }
  if (request.method !== 'GET') {
    send(response, 405, 'Method not allowed', {Allow: 'GET'});
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    send(response, 403, 'Cross-origin request denied');
    return;
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    send(response, 403, 'Cross-site request denied');
    return;
  }
  let pathname: string;
  try {
    pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
  } catch {
    send(response, 400, 'Bad request');
    return;
  }
  void serveAsset(pathname, response);
}

export function createStudioServer(): Server {
  const server = createServer((request, response) => handleRequest(server, request, response));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startStudio(port = 8765): Promise<{server: Server; url: string}> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('GUARDIAN_STUDIO_PORT must be a valid TCP port');
  const server = createStudioServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {server, url: `http://127.0.0.1:${port}/`};
}
