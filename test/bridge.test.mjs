import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('two stdio clients authenticate, list tools and call one shared HTTP server without replaying errors', async () => {
  const sessions = new Map();
  const clients = [];
  let calls = 0;
  const listener = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-api-key'] !== 'test-only-key') { res.writeHead(401).end(); return; }
      let record = sessions.get(req.headers['mcp-session-id']);
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      if (!record) {
        if (body?.method !== 'initialize') { res.writeHead(404).end(); return; }
        const server = new Server({ name: 'test-backend', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', description: 'Test echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
        server.setRequestHandler(CallToolRequestSchema, request => {
          calls++;
          if (request.params.arguments.text === 'fail') return { isError: true, content: [{ type: 'text', text: 'Test failure' }] };
          return { content: [{ type: 'text', text: request.params.arguments.text }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: id => sessions.set(id, { server, transport }) });
        await server.connect(transport);
        record = { server, transport };
      }
      await record.transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${listener.address().port}/mcp`;
  try {
    for (const name of ['first', 'second']) {
      const client = new Client({ name, version: '1.0.0' });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url))], env: { MCP_ENDPOINT: endpoint, MCP_API_KEY: 'test-only-key' }, stderr: 'pipe' }));
    }
    const results = await Promise.all(clients.map(async (client, i) => {
      assert.equal((await client.listTools()).tools[0].name, 'echo');
      return client.callTool({ name: 'echo', arguments: { text: `client-${i}` } });
    }));
    assert.equal(results[0].content[0].text, 'client-0');
    assert.equal(results[1].content[0].text, 'client-1');
    assert.equal((await clients[0].callTool({ name: 'echo', arguments: { text: 'fail' } })).isError, true);
    assert.equal(calls, 3);
    const response = await fetch(endpoint, { method: 'POST', body: '{}' });
    assert.equal(response.status, 401);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
});
