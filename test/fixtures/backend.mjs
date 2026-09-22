#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the provided text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  { name: 'pid', description: 'Return the backend process id', inputSchema: { type: 'object', properties: {} } },
  { name: 'call-count', description: 'Return how many tool calls the backend executed', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'sleep',
    description: 'Wait before returning, to exercise timeouts',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] }
  }
];

let calls = 0;
const server = new Server({ name: 'synthetic-stdio-backend', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  if (name === 'call-count') return { content: [{ type: 'text', text: String(calls) }] };
  calls++;
  if (name === 'echo') {
    if (args.text === 'fail') return { isError: true, content: [{ type: 'text', text: 'Synthetic failure' }] };
    return { content: [{ type: 'text', text: String(args.text) }] };
  }
  if (name === 'pid') return { content: [{ type: 'text', text: String(process.pid) }] };
  if (name === 'sleep') {
    await delay(Math.min(Number(args.ms) || 0, 60000));
    return { content: [{ type: 'text', text: 'slept' }] };
  }
  return { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
});

await server.connect(new StdioServerTransport());