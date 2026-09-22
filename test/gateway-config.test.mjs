import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGatewayConfig, parseArgv } from '../src/gateway-config.mjs';
import { canonicalOrigin, checkApiKey, isAuthorized, isOriginAllowed } from '../src/gateway.mjs';

const KEY = 'test-only-gateway-key';
const base = { GATEWAY_API_KEY: KEY, GATEWAY_BACKEND_COMMAND: 'node' };

test('gateway config applies documented defaults', () => {
  const config = loadGatewayConfig(base);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.path, '/mcp');
  assert.equal(config.healthPath, '/healthz');
  assert.deepEqual(config.allowedOrigins, []);
  assert.deepEqual(config.backend, { command: 'node', args: [], cwd: undefined, env: {} });
  assert.equal(config.sessionTtlMs, 1800000);
  assert.equal(config.maxSessions, 8);
  assert.equal(config.connectTimeoutMs, 60000);
  assert.equal(config.listTimeoutMs, 60000);
  assert.equal(config.callTimeoutMs, 300000);
  assert.equal(config.help, false);
});

test('gateway config reads the API key from a file and rejects ambiguous key sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-key-'));
  try {
    const file = path.join(dir, 'api-key');
    fs.writeFileSync(file, `${KEY}\n`);
    assert.equal(loadGatewayConfig({ GATEWAY_API_KEY_FILE: file, GATEWAY_BACKEND_COMMAND: 'node' }).apiKey, KEY);
    assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_API_KEY_FILE: file }), error => !error.message.includes(KEY));
    assert.throws(() => loadGatewayConfig({ GATEWAY_API_KEY_FILE: '/missing/key-file', GATEWAY_BACKEND_COMMAND: 'node' }), /API key file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway config rejects empty or multi-line keys without echoing them', () => {
  assert.throws(() => loadGatewayConfig({ GATEWAY_API_KEY: '', GATEWAY_BACKEND_COMMAND: 'node' }), /non-empty API key/);
  const multiline = `${KEY}\nsecond-line`;
  assert.throws(() => loadGatewayConfig({ GATEWAY_API_KEY: multiline, GATEWAY_BACKEND_COMMAND: 'node' }), error => !error.message.includes(multiline) && !error.message.includes(KEY));
});

test('gateway config requires a backend command and validates its inputs', () => {
  assert.throws(() => loadGatewayConfig({ GATEWAY_API_KEY: KEY }), /backend command/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_BACKEND_ARGS: 'not-json' }), /JSON array/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_BACKEND_ARGS: '{"a":1}' }), /JSON array of strings/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_BACKEND_ENV: '[]' }), /JSON object/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_BACKEND_ENV: '{"N":1}' }), /string values/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_BACKEND_CWD: '/definitely/missing/dir' }), /working directory/);
  const config = loadGatewayConfig({
    ...base,
    GATEWAY_BACKEND_ARGS: '["--flag","value"]',
    GATEWAY_BACKEND_ENV: '{"GATEWAY_API_KEY":"leaked","GATEWAY_BACKEND_ONLY":"yes"}'
  });
  assert.deepEqual(config.backend.args, ['--flag', 'value']);
  assert.deepEqual(config.backend.env, { GATEWAY_BACKEND_ONLY: 'yes' });
});

test('gateway config validates host, port, paths, limits, timeouts and origins', () => {
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_HOST: 'bad host' }), /GATEWAY_HOST/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_PORT: '70000' }), /GATEWAY_PORT/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_PORT: 'abc' }), /GATEWAY_PORT/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_PATH: 'mcp' }), /GATEWAY_PATH/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_PATH: '/mcp?x=1' }), /GATEWAY_PATH/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_HEALTH_PATH: '/mcp' }), /health path/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_SESSION_TTL_MS: '0' }), /GATEWAY_SESSION_TTL_MS/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_MAX_SESSIONS: '0' }), /GATEWAY_MAX_SESSIONS/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_CALL_TIMEOUT_MS: 'soon' }), /GATEWAY_CALL_TIMEOUT_MS/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_ALLOWED_ORIGINS: 'trusted.example' }), /Allowed origins/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_ALLOWED_ORIGINS: 'ftp://trusted.example' }), /Allowed origins/);
  const config = loadGatewayConfig({ ...base, GATEWAY_ALLOWED_ORIGINS: 'https://trusted.example, http://127.0.0.1:5173' });
  assert.deepEqual(config.allowedOrigins, ['https://trusted.example', 'http://127.0.0.1:5173']);
});

test('gateway CLI flags override environment configuration', () => {
  const config = loadGatewayConfig(
    { ...base, GATEWAY_HOST: '0.0.0.0', GATEWAY_PORT: '9000', GATEWAY_ALLOWED_ORIGINS: 'https://env.example' },
    ['--host=127.0.0.1', '--port', '0', '--backend', 'node', '--backend-arg', 'a.mjs', '--backend-arg', 'b',
      '--allow-origin', 'https://cli.example', '--path', '/rpc', '--max-sessions', '2']
  );
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 0);
  assert.equal(config.path, '/rpc');
  assert.equal(config.maxSessions, 2);
  assert.deepEqual(config.backend.args, ['a.mjs', 'b']);
  assert.deepEqual(config.allowedOrigins, ['https://cli.example']);
  assert.deepEqual(parseArgv(['--help']), { help: true });
  assert.deepEqual(loadGatewayConfig({}, ['--help']), { help: true });
  assert.throws(() => parseArgv(['--nope']), /Unknown option/);
  assert.throws(() => parseArgv(['--host']), /Missing value/);
});

test('constant-time API key checks accept both headers and never short-circuit', () => {
  assert.equal(checkApiKey(KEY, KEY), true);
  assert.equal(checkApiKey('other', KEY), false);
  assert.equal(checkApiKey('', KEY), false);
  assert.equal(isAuthorized({ 'x-api-key': KEY }, KEY), true);
  assert.equal(isAuthorized({ authorization: `Bearer ${KEY}` }, KEY), true);
  assert.equal(isAuthorized({ authorization: `Basic ${KEY}` }, KEY), false);
  assert.equal(isAuthorized({ 'x-api-key': 'wrong' }, KEY), false);
  assert.equal(isAuthorized({}, KEY), false);
  assert.equal(isAuthorized({ 'x-api-key': KEY, authorization: 'Bearer wrong' }, KEY), true);
});

test('browser origins are rejected unless explicitly allowlisted', () => {
  assert.equal(isOriginAllowed(undefined, []), true);
  assert.equal(isOriginAllowed('', []), true);
  assert.equal(isOriginAllowed('https://evil.example', []), false);
  assert.equal(isOriginAllowed('https://trusted.example', ['https://trusted.example']), true);
  assert.equal(isOriginAllowed('https://trusted.example/app', ['https://trusted.example']), true);
  assert.equal(isOriginAllowed('https://other.example', ['https://trusted.example']), false);
  assert.equal(canonicalOrigin('https://trusted.example/'), 'https://trusted.example');
});