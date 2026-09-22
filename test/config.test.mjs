import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('CNB discovery can read a non-interactive token from CNB_TOKEN_FILE without exposing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnb-token-file-'));
  try {
    const tokenFile = path.join(dir, 'token');
    const cliFile = path.join(dir, 'fake-cnb.mjs');
    fs.writeFileSync(tokenFile, 'test-cnb-token\n', { mode: 0o600 });
    fs.writeFileSync(cliFile, `if (process.env.CNB_TOKEN !== 'test-cnb-token') process.exit(7);\nconsole.log(JSON.stringify({data:{list:[{slug:'example/workspace',status:'running',business_id:'example123'}]}}));\n`);
    const config = loadConfig({
      CNB_REPOSITORY: 'example/workspace',
      CNB_CLI_PATH: cliFile,
      CNB_TOKEN_FILE: tokenFile,
      MCP_API_KEY: 'test-only-key'
    });
    assert.equal((await resolveEndpoint(config)).href, 'https://example123-8000.cnb.run/mcp');
    assert.throws(() => loadConfig({ ...basic, CNB_TOKEN_FILE: tokenFile }), /only valid with CNB_REPOSITORY/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});