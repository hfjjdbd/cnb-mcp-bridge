import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SHUTDOWN_DRAIN_MS = 5000;

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function checkApiKey(provided, expected) {
  return timingSafeEqual(digest(provided ?? ''), digest(expected ?? ''));
}

function headerValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function isAuthorized(headers, expectedApiKey) {
  const apiKeyHeader = headerValue(headers, 'x-api-key');
  const authorization = headerValue(headers, 'authorization');
  const bearer = /^Bearer[ \t]+/i.test(authorization) ? authorization.replace(/^Bearer[ \t]+/i, '') : '';
  // Both comparisons always run so the result does not depend on which header was sent.
  const matchesApiKeyHeader = checkApiKey(apiKeyHeader, expectedApiKey);
  const matchesBearer = checkApiKey(bearer, expectedApiKey);
  return Boolean(matchesApiKeyHeader | matchesBearer);
}

export function canonicalOrigin(value) {
  try { return new URL(String(value)).origin; }
  catch { return String(value); }
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (origin === undefined || origin === null || origin === '') return true;
  const candidate = canonicalOrigin(origin);
  return allowedOrigins.some(entry => canonicalOrigin(entry) === candidate);
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: id ?? null };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createBackend(config) {
  const state = { client: undefined, pending: undefined, closing: false };

  async function open() {
    if (state.closing) throw new Error('Gateway is shutting down');
    const transport = new StdioClientTransport({
      command: config.backend.command,
      args: config.backend.args,
      cwd: config.backend.cwd,
      env: config.backend.env,
      stderr: 'ignore'
    });
    const client = new Client({ name: 'cnb-mcp-gateway', version: '0.1.0' });
    client.onclose = () => {
      if (state.client === client) state.client = undefined;
    };
    try {
      await client.connect(transport, { timeout: config.connectTimeoutMs });
    } catch {
      await client.close().catch(() => {});
      throw new Error('Cannot start the configured stdio backend; check the command, arguments and working directory');
    }
    if (state.closing) {
      await client.close().catch(() => {});
      throw new Error('Gateway is shutting down');
    }
    state.client = client;
    return client;
  }

  return {
    async ensure() {
      if (state.closing) throw new Error('Gateway is shutting down');
      if (state.client) return state.client;
      state.pending ||= open().finally(() => { state.pending = undefined; });
      return state.pending;
    },
    status() {
      if (state.closing) return 'closed';
      if (state.client) return 'connected';
      if (state.pending) return 'starting';
      return 'disconnected';
    },
    async close() {
      state.closing = true;
      const pending = state.pending;
      if (pending) await pending.catch(() => {});
      const client = state.client;
      state.client = undefined;
      if (client) await client.close().catch(() => {});
    }
  };
}

export function createGateway(config, options = {}) {
  const log = options.log ?? ((level, message) => { console.error(`[gateway] ${level}: ${message}`); });
  const sessions = new Map();
  const backend = createBackend(config);
  const state = { closing: false, sweepTimer: undefined, activeCalls: 0, closingPromise: undefined };

  function emit(level, message) {
    // Never let key material reach a log sink, whatever the sink is.
    const safe = config.apiKey ? String(message).split(config.apiKey).join('[redacted]') : String(message);
    try { log(level, safe); } catch {}
  }

  function isExpired(record) {
    return !record.streaming && Date.now() - record.lastActivity >= config.sessionTtlMs;
  }

  async function destroyRecord(record) {
    try { await record.transport.close(); } catch {}
    try { await record.server.close(); } catch {}
  }

  async function removeSession(sessionId) {
    const record = sessions.get(sessionId);
    if (!record) return;
    sessions.delete(sessionId);
    await destroyRecord(record);
  }

  async function createSession() {
    const record = { sessionId: undefined, server: undefined, transport: undefined, lastActivity: Date.now(), streaming: false };
    const server = new Server({ name: 'cnb-mcp-gateway', version: '0.1.0' }, {
      capabilities: { tools: {} },
      instructions: 'Tools run on one shared local stdio backend process. Other users may share its files and terminals. After a timeout or connection error, inspect state before repeating a mutation; the previous call may already have completed. Do not bulk-delete files or directories.'
    });
    server.setRequestHandler(ListToolsRequestSchema, async request => {
      const client = await backend.ensure();
      try {
        return await client.listTools(request.params ?? {}, { timeout: config.listTimeoutMs });
      } catch {
        throw new Error('Unable to list backend tools; check the backend process configuration');
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      state.activeCalls++;
      try {
        const client = await backend.ensure();
        // One attempt only: the backend operation might already have completed.
        return await client.callTool(request.params, undefined, { timeout: config.callTimeoutMs, signal: extra.signal });
      } catch {
        throw new Error('Backend call failed or timed out; inspect state before retrying');
      } finally {
        state.activeCalls--;
      }
    });
    record.server = server;
    record.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: sessionId => {
        record.sessionId = sessionId;
        record.lastActivity = Date.now();
        sessions.set(sessionId, record);
      },
      onsessionclosed: sessionId => { void removeSession(sessionId); }
    });
    await server.connect(record.transport);
    const transportClosed = record.transport.onclose;
    record.transport.onclose = () => {
      transportClosed?.();
      if (record.sessionId) void removeSession(record.sessionId);
    };
    return record;
  }

  function sweep() {
    if (state.closing) return;
    const now = Date.now();
    for (const [sessionId, record] of [...sessions]) {
      if (record.streaming) continue;
      if (now - record.lastActivity >= config.sessionTtlMs) {
        emit('info', 'closing idle session');
        void removeSession(sessionId);
      }
    }
  }

  function handleHealth(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    sendJson(res, state.closing ? 503 : 200, {
      status: state.closing ? 'shutting_down' : 'ok',
      sessions: sessions.size,
      maxSessions: config.maxSessions,
      backend: backend.status()
    });
  }

  async function handleMcp(req, res, url) {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      emit('warn', 'rejected request: origin is not allowlisted');
      sendJson(res, 403, rpcError(null, -32000, 'Origin not allowed'));
      return;
    }
    if (!isAuthorized(req.headers, config.apiKey)) {
      emit('warn', 'rejected request: missing or invalid API key');
      sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'), { 'www-authenticate': 'Bearer realm="mcp"' });
      return;
    }
    if (state.closing) {
      sendJson(res, 503, rpcError(null, -32002, 'Gateway is shutting down'));
      return;
    }

    const sessionId = headerValue(req.headers, 'mcp-session-id');

    if (req.method === 'POST') {
      const raw = await readBody(req, MAX_BODY_BYTES);
      let body;
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; }
      catch { sendJson(res, 400, rpcError(null, -32700, 'Parse error')); return; }

      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record || isExpired(record)) {
          if (record) await removeSession(sessionId);
          sendJson(res, 404, rpcError(null, -32001, 'Session not found'));
          return;
        }
        record.lastActivity = Date.now();
        await record.transport.handleRequest(req, res, body);
        return;
      }

      if (!body || body.method !== 'initialize') {
        sendJson(res, 400, rpcError(null, -32000, 'Session required'));
        return;
      }
      if (sessions.size >= config.maxSessions) {
        emit('warn', 'rejected initialize: session limit reached');
        sendJson(res, 503, rpcError(null, -32003, 'Too many sessions'));
        return;
      }
      const record = await createSession();
      try {
        await record.transport.handleRequest(req, res, body);
      } finally {
        if (!record.sessionId) await destroyRecord(record);
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const record = sessionId ? sessions.get(sessionId) : undefined;
      if (!record || (req.method === 'GET' && isExpired(record))) {
        if (record) await removeSession(sessionId);
        sendJson(res, 404, rpcError(null, -32001, 'Session not found'));
        return;
      }
      record.lastActivity = Date.now();
      if (req.method === 'GET') {
        record.streaming = true;
        res.on('close', () => {
          record.streaming = false;
          record.lastActivity = Date.now();
        });
        await record.transport.handleRequest(req, res);
      } else {
        await record.transport.handleRequest(req, res);
        await removeSession(sessionId);
      }
      return;
    }

    sendJson(res, 405, rpcError(null, -32000, 'Method not allowed'), { allow: 'GET, POST, DELETE' });
  }

  const httpServer = http.createServer((req, res) => {
    const run = async () => {
      const url = new URL(req.url || '/', 'http://gateway.invalid');
      if (url.pathname === config.healthPath) {
        handleHealth(req, res);
        return;
      }
      if (url.pathname !== config.path) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      await handleMcp(req, res, url);
    };
    run().catch(error => {
      emit('error', `request failed: ${error?.message ?? error}`);
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (error?.statusCode === 413) {
        res.setHeader('connection', 'close');
        sendJson(res, 413, rpcError(null, -32000, 'Payload too large'));
        req.destroy();
        return;
      }
      sendJson(res, 500, rpcError(null, -32603, 'Internal error'));
    });
  });

  async function start() {
    await new Promise((resolve, reject) => {
      const onError = error => reject(new Error(`Cannot listen on ${config.host}:${config.port}: ${error.code ?? error.message}`));
      httpServer.once('error', onError);
      httpServer.listen(config.port, config.host, () => {
        httpServer.off('error', onError);
        resolve();
      });
    });
    const interval = Math.max(50, Math.min(Math.floor(config.sessionTtlMs / 2), 15000));
    state.sweepTimer = setInterval(sweep, interval);
    state.sweepTimer.unref?.();
    emit('info', `listening on http://${config.host}:${httpServer.address().port}${config.path}`);
    return httpServer.address();
  }

  async function stop() {
    if (state.closingPromise) return state.closingPromise;
    state.closing = true;
    state.closingPromise = (async () => {
      if (state.sweepTimer) clearInterval(state.sweepTimer);
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      while (state.activeCalls > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await Promise.allSettled([...sessions.keys()].map(sessionId => removeSession(sessionId)));
      await backend.close();
      await new Promise(resolve => {
        httpServer.close(resolve);
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
      });
      emit('info', 'stopped');
    })();
    return state.closingPromise;
  }

  return {
    config,
    httpServer,
    start,
    stop,
    address: () => httpServer.address(),
    sessionCount: () => sessions.size,
    backendStatus: () => backend.status()
  };
}