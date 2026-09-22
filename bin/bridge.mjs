#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.mjs';
import { connect, disconnect } from '../src/connection.mjs';

let config;
try { config = loadConfig(); }
catch (error) { console.error(error.message); process.exit(1); }

let connection;
let connecting;
let active = 0;
let closing = false;
async function ensureConnection() {
  if (connection) return connection;
  connecting ||= connect(config).then(value => {
    connection = value;
    value.client.onclose = () => { if (connection === value) connection = undefined; };
    return value;
  }).finally(() => { connecting = undefined; });
  return connecting;
}
const server = new Server({ name: 'cnb-mcp-bridge', version: '0.1.0' }, {
  capabilities: { tools: {} },
  instructions: 'Tools execute on the configured remote MCP server. Other agents may share files and process lists: use your own processes and avoid interrupting others. After a connection error, inspect state before repeating a mutation; the previous call may have executed. Do not bulk-delete files or directories.'
});
server.setRequestHandler(ListToolsRequestSchema, async request => {
  try { return await (await ensureConnection()).client.listTools(request.params); }
  catch { throw new Error('Unable to list remote tools; check the endpoint and authentication'); }
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  active++;
  try {
    const remote = await ensureConnection();
    return await remote.client.callTool(request.params, undefined, { timeout: 300000, signal: extra.signal });
  } catch {
    // No automatic replay: the remote operation might already have completed.
    throw new Error('Remote call failed or timed out; inspect state before retrying');
  } finally { active--; }
});
const heartbeat = setInterval(async () => {
  const current = connection;
  if (!current || active || closing) return;
  try { await current.client.ping({ timeout: 10000 }); }
  catch {
    if (connection === current) connection = undefined;
    await disconnect(current);
  }
}, 60000);
heartbeat.unref();
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  if (connecting) await connecting.catch(() => {});
  await disconnect(connection);
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
await server.connect(new StdioServerTransport());
