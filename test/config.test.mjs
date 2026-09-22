import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, selectWorkspace, validateEndpoint } from '../src/config.mjs';
import { resolveEndpoint } from '../src/connection.mjs';

const basic = { MCP_ENDPOINT: 'https://mcp.example.com/mcp', MCP_API_KEY: 'test-only-key' };
test('static endpoint needs no CNB credential or CLI', async () => {
  const config = loadConfig(basic);
  assert.equal((await resolveEndpoint(config)).href, basic.MCP_ENDPOINT);
  assert.equal(config.headers['X-API-Key'], 'test-only-key');
});
test('reject ambiguous auth and endpoint configuration without echoing key values', () => {
  for (const extra of [{ MCP_API_KEY_FILE: '/unused' }, { CNB_REPOSITORY: 'example/workspace' }, { MCP_AUTH_HEADER: 'Host' }]) {
    assert.throws(() => loadConfig({ ...basic, ...extra }), error => !error.message.includes(basic.MCP_API_KEY));
  }
});
test('allow HTTPS and loopback HTTP; reject leaked URL credentials and cleartext remote HTTP', () => {
  for (const endpoint of ['https://mcp.example.com/mcp', 'http://127.0.0.1:8000/mcp', 'http://[::1]:8000/mcp']) assert.doesNotThrow(() => validateEndpoint(endpoint));
  for (const endpoint of ['http://mcp.example.com/mcp', 'https://user:secret@mcp.example.com/mcp', 'https://mcp.example.com/mcp?token=secret', 'file:///tmp/mcp']) assert.throws(() => validateEndpoint(endpoint));
});
test('CNB selects only the exact configured running repository', () => {
  const target = { slug: 'example/workspace', status: 'running', business_id: 'example123' };
  const other = { ...target, slug: 'example/other' };
  assert.equal(selectWorkspace({ data: { list: [other, target] } }, target.slug), target);
  for (const list of [[], [other], [target, target], [{ ...target, status: 'closed' }], [{ ...target, business_id: 'bad.example/path' }]]) {
    assert.throws(() => selectWorkspace({ data: { list } }, target.slug));
  }
});
