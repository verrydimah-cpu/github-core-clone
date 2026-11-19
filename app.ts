// app.ts — the forge's HTTP server: one listener carrying git smart HTTP, REST v3, GraphQL v4
// and MCP over the single store in store.ts. Cross-cutting rules live here and nowhere else:
// the bearer token gate (every surface answers 401 without it), the X-GitHub-Request-Id header
// on every reply, JSON error bodies with a `message`, and a hard guarantee that a malformed
// request is an answer, never a crashed process.
//
// app.ts is deliberately separate from main.ts: this is the server; main.ts is the entry <-> env
// lifecycle and stays as the harness wrote it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack, type Reply } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

/** The token every surface expects, read once from the process environment. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether the request carries the suite's bearer token (or no token is configured at all). */
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${SHOP_TOKEN}`;
}

function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...reply.headers };
  if (reply.contentType !== '') headers['content-type'] = reply.contentType;
  if (reply.status !== 204) headers['content-length'] = String(reply.body.length);
  res.writeHead(reply.status, headers);
  res.end(reply.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  sendReply(res, { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') }, requestId);
}

/** Read a whole request body (git packs included), rejecting absurd sizes. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** Percent-decode one path segment; a malformed escape is left as-is rather than thrown. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Route and answer one request. Everything fallible is inside the caller's try/catch. */
async function dispatch(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const pathname = url.pathname;
  const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);

  // The env's boot check calls this twice: 200 {"ok":true}. It is not an API surface; no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return;
    }
    const owner = decodeSegment(gitMatch[1]);
    const repoName = decodeSegment(gitMatch[2]);
    const repo = store.repoFor(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const tail = gitMatch[3];
    if (method === 'GET' && tail === 'info/refs') {
      const reply = infoRefs(repo, url.searchParams.get('service') ?? '', req.headers['git-protocol'] ?? '');
      sendReply(res, reply, requestId);
      return;
    }
    if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
      const body = await readBody(req);
      try {
        const reply = tail === 'git-upload-pack' ? uploadPack(repo, body) : receivePack(repo, body);
        sendReply(res, reply, requestId);
      } catch {
        // A malformed pack or pkt-line stream is a 400, never a dead server.
        sendReply(res, { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad git request\n') }, requestId);
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const body = await readBody(req);
    sendReply(res, handleGraphQL(body), requestId);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
      return;
    }
    const body = await readBody(req);
    sendReply(res, handleMcp(body), requestId);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return;
    }
    const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const restSegments = segments.slice(2);
    const reply = handleRest(method, restSegments, url.searchParams, body, req.headers.host ?? 'localhost');
    // The API root carries the OAuth scopes header, as api.github.com answers GET /.
    if (method === 'GET' && restSegments.length === 0) reply.headers = { ...reply.headers, 'x-oauth-scopes': 'repo, read:org' };
    sendReply(res, reply, requestId);
    return;
  }

  void segments;
  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
    dispatch(req, res, requestId).catch(() => {
      // Last-resort guard: a request must always get an answer.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        else res.end();
      } catch {
        // The socket is already gone; nothing more can be done for this request.
      }
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return server;
}
