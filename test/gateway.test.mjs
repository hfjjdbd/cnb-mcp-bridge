import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadGatewayConfig } from '../src/gateway-config.mjs';
import { createGateway } from '../src/gateway.mjs';

const KEY = 'test-only-gateway-key';
const BACKEND = fileURLToPath(new URL('./fixtures/backend.mjs', import.meta.url));
const BRIDGE = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url));

function defaultEnv(overrides = {}) {
  return {
    GATEWAY_API_KEY: KEY,
    GATEWAY_BACKEND_COMMAND: process.execPath,
    GATEWAY_BACKEND_ARGS: JSON.stringify([BACKEND]),
    GATEWAY_BACKEND_CWD: fileURLToPath(new URL('.', import.meta.url)),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: '0',
    ...overrides
  };
}

async function startGateway(t, envOverrides = {}) {
  const logs = [];
  const config = loadGatewayConfig(defaultEnv(envOverrides));
  const gateway = createGateway(config, { log: (level, message) => logs.push(`${level}: ${message}`) });
  await gateway.start();
  t.after(() => gateway.stop());
  const baseUrl = `http://127.0.0.1:${gateway.address().port}`;
  return { gateway, config, logs, baseUrl, mcpUrl: `${baseUrl}${config.path}`, healthUrl: `${baseUrl}${config.healthPath}` };
}

function rpcHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': KEY,
    ...extra
  };
}

function initializeBody(id = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gateway-test', version: '1.0.0' }
    }
  });
}

async function connectHttpClient(mcpUrl, name) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { 'x-api-key': KEY } }
  }));
  return client;
}

test('gateway requires the configured API key and never logs it', async t => {
  const { mcpUrl, logs } = await startGateway(t);

  const anonymous = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: initializeBody() });
  assert.equal(anonymous.status, 401);
  assert.ok(!(await anonymous.text()).includes(KEY));

  const wrong = await fetch(mcpUrl, { method: 'POST', headers: rpcHeaders({ 'x-api-key': 'wrong-key' }), body: initializeBody() });
  assert.equal(wrong.status, 401);

  const bearerHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` };
  const bearer = await fetch(mcpUrl, { method: 'POST', headers: bearerHeaders, body: initializeBody() });
  assert.equal(bearer.status, 200);
  assert.ok(bearer.headers.get('mcp-session-id'));
  await bearer.text();

  const apiKeyHeader = await fetch(mcpUrl, { method: 'POST', headers: rpcHeaders(), body: initializeBody(2) });
  assert.equal(apiKeyHeader.status, 200);
  await apiKeyHeader.text();

  assert.ok(logs.some(line => line.includes('invalid API key')));
  assert.ok(logs.every(line => !line.includes(KEY)));
});

test('gateway proxies tools/list and tools/call to the local stdio backend', async t => {
  const { mcpUrl } = await startGateway(t);
  const client = await connectHttpClient(mcpUrl, 'list-call');
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'echo'));
    const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hello-gateway' } });
    assert.equal(echoed.content[0].text, 'hello-gateway');
    const failed = await client.callTool({ name: 'echo', arguments: { text: 'fail' } });
    assert.equal(failed.isError, true);
    await assert.rejects(client.readResource({ uri: 'file:///tmp/never' }), /Method not found|not found/i);
    await assert.rejects(client.listPrompts(), /Method not found|not found/i);
  } finally {
    await client.close();
  }
});

test('two HTTP clients share one stdio backend through separate sessions', async t => {
  const { mcpUrl, healthUrl, gateway } = await startGateway(t);
  const clients = [];
  try {
    clients.push(await connectHttpClient(mcpUrl, 'first'), await connectHttpClient(mcpUrl, 'second'));
    const results = await Promise.all(clients.map(async (client, index) => {
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'echo'));
      return client.callTool({ name: 'echo', arguments: { text: `client-${index}` } });
    }));
    assert.equal(results[0].content[0].text, 'client-0');
    assert.equal(results[1].content[0].text, 'client-1');
    const pids = await Promise.all(clients.map(async client => (await client.callTool({ name: 'pid', arguments: {} })).content[0].text));
    assert.equal(pids[0], pids[1]);
    assert.equal(gateway.sessionCount(), 2);
    const health = await (await fetch(healthUrl)).json();
    assert.equal(health.sessions, 2);
    assert.equal(health.backend, 'connected');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
});

test('browser origins are rejected unless allowlisted', async t => {
  const strict = await startGateway(t);
  const rejected = await fetch(strict.mcpUrl, {
    method: 'POST',
    headers: rpcHeaders({ origin: 'https://evil.example' }),
    body: initializeBody()
  });
  assert.equal(rejected.status, 403);
  await rejected.text();

  const allowed = await startGateway(t, { GATEWAY_ALLOWED_ORIGINS: 'https://trusted.example' });
  const trusted = await fetch(allowed.mcpUrl, {
    method: 'POST',
    headers: rpcHeaders({ origin: 'https://trusted.example' }),
    body: initializeBody()
  });
  assert.equal(trusted.status, 200);
  assert.ok(trusted.headers.get('mcp-session-id'));
  await trusted.text();
  const stillRejected = await fetch(allowed.mcpUrl, {
    method: 'POST',
    headers: rpcHeaders({ origin: 'https://evil.example' }),
    body: initializeBody(2)
  });
  assert.equal(stillRejected.status, 403);
  await stillRejected.text();
});

test('unknown sessions are rejected and the health endpoint reports status', async t => {
  const { mcpUrl, healthUrl, gateway, baseUrl } = await startGateway(t);

  const healthResponse = await fetch(healthUrl);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.sessions, 0);
  assert.equal(health.maxSessions, 8);
  assert.ok(!JSON.stringify(health).includes(KEY));

  const unknown = await fetch(mcpUrl, {
    method: 'POST',
    headers: rpcHeaders({ 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  assert.equal(unknown.status, 404);
  await unknown.text();

  const missingSession = await fetch(mcpUrl, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  });
  assert.equal(missingSession.status, 400);
  await missingSession.text();

  const elsewhere = await fetch(`${baseUrl}/not-mcp`);
  assert.equal(elsewhere.status, 404);
  await elsewhere.text();

  const wrongMethod = await fetch(healthUrl, { method: 'POST', body: '{}' });
  assert.equal(wrongMethod.status, 405);
  await wrongMethod.text();

  await gateway.stop();
  await assert.rejects(fetch(healthUrl));
});

test('the stdio bridge can use the gateway as its remote MCP endpoint', async t => {
  const { mcpUrl } = await startGateway(t);
  const client = new Client({ name: 'bridge-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    env: { MCP_ENDPOINT: mcpUrl, MCP_API_KEY: KEY },
    stderr: 'pipe'
  });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'echo'));
  const result = await client.callTool({ name: 'echo', arguments: { text: 'via-bridge' } });
  assert.equal(result.content[0].text, 'via-bridge');
});

test('idle sessions expire after the TTL and new sessions are capped', async t => {
  const ttl = await startGateway(t, { GATEWAY_SESSION_TTL_MS: '200' });
  const init = await fetch(ttl.mcpUrl, { method: 'POST', headers: rpcHeaders(), body: initializeBody() });
  assert.equal(init.status, 200);
  const sessionId = init.headers.get('mcp-session-id');
  await init.text();
  assert.equal(ttl.gateway.sessionCount(), 1);
  await delay(400);
  assert.equal(ttl.gateway.sessionCount(), 0);
  const expired = await fetch(ttl.mcpUrl, {
    method: 'POST',
    headers: rpcHeaders({ 'mcp-session-id': sessionId }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
  });
  assert.equal(expired.status, 404);
  await expired.text();

  const capped = await startGateway(t, { GATEWAY_MAX_SESSIONS: '1' });
  const client = await connectHttpClient(capped.mcpUrl, 'only-session');
  try {
    const second = await fetch(capped.mcpUrl, { method: 'POST', headers: rpcHeaders(), body: initializeBody(9) });
    assert.equal(second.status, 503);
    await second.text();
    assert.equal(capped.gateway.sessionCount(), 1);
  } finally {
    await client.close();
  }
});

test('a timed-out tool call reaches the backend exactly once and is never replayed', async t => {
  const { mcpUrl } = await startGateway(t, { GATEWAY_CALL_TIMEOUT_MS: '150' });
  const client = await connectHttpClient(mcpUrl, 'timeout-client');
  try {
    const before = Number((await client.callTool({ name: 'call-count', arguments: {} })).content[0].text);
    await assert.rejects(client.callTool({ name: 'sleep', arguments: { ms: 800 } }), /inspect state before retrying/);
    const after = Number((await client.callTool({ name: 'call-count', arguments: {} })).content[0].text);
    assert.equal(after - before, 1);
    await delay(800);
    assert.equal(Number((await client.callTool({ name: 'call-count', arguments: {} })).content[0].text), after);
  } finally {
    await client.close();
  }
});