import fs from 'node:fs';

export const GATEWAY_USAGE = `Usage: cnb-mcp-gateway [options]

Self-hosted authenticated Streamable HTTP MCP gateway for one local stdio MCP backend.

Options:
  --host <host>               Bind address (default 127.0.0.1)
  --port <port>               Bind port (default 8787, 0 picks a free port)
  --path <path>               MCP endpoint path (default /mcp)
  --health-path <path>        Health endpoint path (default /healthz)
  --backend <command>         Stdio backend command (required)
  --backend-arg <value>       Backend argument, repeatable (replaces GATEWAY_BACKEND_ARGS)
  --cwd <dir>                 Backend working directory
  --api-key-file <file>       Read the API key from a file
  --allow-origin <origin>     Allowlisted browser Origin, repeatable (replaces GATEWAY_ALLOWED_ORIGINS)
  --session-ttl-ms <ms>       Idle session lifetime (default 1800000)
  --max-sessions <count>      Concurrent session limit (default 8)
  --connect-timeout-ms <ms>   Backend connect timeout (default 60000)
  --list-timeout-ms <ms>      tools/list timeout (default 60000)
  --call-timeout-ms <ms>      tools/call timeout (default 300000)
  -h, --help                  Show this help

Environment:
  GATEWAY_API_KEY or GATEWAY_API_KEY_FILE   Required API key (never both)
  GATEWAY_HOST, GATEWAY_PORT, GATEWAY_PATH, GATEWAY_HEALTH_PATH
  GATEWAY_BACKEND_COMMAND, GATEWAY_BACKEND_ARGS (JSON array), GATEWAY_BACKEND_CWD,
  GATEWAY_BACKEND_ENV (JSON object)
  GATEWAY_ALLOWED_ORIGINS (comma-separated origins)
  GATEWAY_SESSION_TTL_MS, GATEWAY_MAX_SESSIONS
  GATEWAY_CONNECT_TIMEOUT_MS, GATEWAY_LIST_TIMEOUT_MS, GATEWAY_CALL_TIMEOUT_MS
`;

const VALUE_FLAGS = new Map([
  ['--host', 'host'],
  ['--port', 'port'],
  ['--path', 'path'],
  ['--health-path', 'healthPath'],
  ['--backend', 'backend'],
  ['--cwd', 'cwd'],
  ['--api-key-file', 'apiKeyFile'],
  ['--session-ttl-ms', 'sessionTtlMs'],
  ['--max-sessions', 'maxSessions'],
  ['--connect-timeout-ms', 'connectTimeoutMs'],
  ['--list-timeout-ms', 'listTimeoutMs'],
  ['--call-timeout-ms', 'callTimeoutMs']
]);

const LIST_FLAGS = new Map([
  ['--backend-arg', 'backendArgs'],
  ['--allow-origin', 'allowedOrigins']
]);

export function parseArgv(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const takeValue = () => {
      if (equals !== -1) return argument.slice(equals + 1);
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${name}`);
      return value;
    };
    if (VALUE_FLAGS.has(name)) {
      parsed[VALUE_FLAGS.get(name)] = takeValue();
    } else if (LIST_FLAGS.has(name)) {
      const key = LIST_FLAGS.get(name);
      (parsed[key] ??= []).push(takeValue());
    } else {
      throw new Error(`Unknown option: ${name}`);
    }
  }
  return parsed;
}

function readInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function readPath(value, label) {
  if (typeof value !== 'string' || !/^\/[^\s?#]*$/.test(value)) {
    throw new Error(`${label} must be an absolute path starting with '/'`);
  }
  return value;
}

function readOriginEntry(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Allowed origins must be http(s) origin URLs'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Allowed origins must be http(s) origin URLs');
  if (url.username || url.password) throw new Error('Allowed origins must not contain credentials');
  return url.origin;
}

function readJsonObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} must be a JSON object`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

export function loadGatewayConfig(env = process.env, argv = []) {
  const flags = Array.isArray(argv) ? parseArgv(argv) : {};
  if (flags.help) return { help: true };

  const keyFile = flags.apiKeyFile ?? env.GATEWAY_API_KEY_FILE;
  if (env.GATEWAY_API_KEY && keyFile) throw new Error('Choose GATEWAY_API_KEY or an API key file, not both');
  if (env.GATEWAY_API_KEY_FILE && flags.apiKeyFile) throw new Error('Choose a single API key file source');
  let apiKey = env.GATEWAY_API_KEY || '';
  if (keyFile) {
    try { apiKey = fs.readFileSync(keyFile, 'utf8').trim(); }
    catch { throw new Error('Cannot read the API key file'); }
  }
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Provide a non-empty API key without line breaks');

  const host = flags.host ?? env.GATEWAY_HOST ?? '127.0.0.1';
  if (typeof host !== 'string' || !host.trim() || /[\s\0]/.test(host)) throw new Error('GATEWAY_HOST must be a non-empty address');

  const port = readInteger(flags.port ?? env.GATEWAY_PORT ?? 8787, 'GATEWAY_PORT', 0, 65535);
  const path = readPath(flags.path ?? env.GATEWAY_PATH ?? '/mcp', 'GATEWAY_PATH');
  const healthPath = readPath(flags.healthPath ?? env.GATEWAY_HEALTH_PATH ?? '/healthz', 'GATEWAY_HEALTH_PATH');
  if (path === healthPath) throw new Error('The health path must differ from the MCP path');

  const command = flags.backend ?? env.GATEWAY_BACKEND_COMMAND;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) {
    throw new Error('Set the backend command with GATEWAY_BACKEND_COMMAND or --backend');
  }
  let backendArgs;
  if (flags.backendArgs) {
    backendArgs = flags.backendArgs;
  } else if (env.GATEWAY_BACKEND_ARGS) {
    try { backendArgs = JSON.parse(env.GATEWAY_BACKEND_ARGS); }
    catch { throw new Error('GATEWAY_BACKEND_ARGS must be a JSON array of strings'); }
  } else {
    backendArgs = [];
  }
  if (!Array.isArray(backendArgs) || backendArgs.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new Error('Backend arguments must be a JSON array of strings');
  }

  const cwd = flags.cwd ?? env.GATEWAY_BACKEND_CWD;
  if (cwd && (typeof cwd !== 'string' || !fs.existsSync(cwd))) throw new Error('The backend working directory does not exist');

  let backendEnv = {};
  if (env.GATEWAY_BACKEND_ENV) {
    backendEnv = readJsonObject(env.GATEWAY_BACKEND_ENV, 'GATEWAY_BACKEND_ENV');
    if (Object.values(backendEnv).some(value => typeof value !== 'string')) {
      throw new Error('GATEWAY_BACKEND_ENV must map names to string values');
    }
    backendEnv = { ...backendEnv };
    // Never hand the gateway key material to the backend process.
    delete backendEnv.GATEWAY_API_KEY;
    delete backendEnv.GATEWAY_API_KEY_FILE;
  }

  let allowedOrigins = [];
  if (env.GATEWAY_ALLOWED_ORIGINS) {
    allowedOrigins = env.GATEWAY_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean).map(readOriginEntry);
  }
  if (flags.allowedOrigins) allowedOrigins = flags.allowedOrigins.map(readOriginEntry);

  const sessionTtlMs = readInteger(flags.sessionTtlMs ?? env.GATEWAY_SESSION_TTL_MS ?? 1800000, 'GATEWAY_SESSION_TTL_MS', 1, 86400000);
  const maxSessions = readInteger(flags.maxSessions ?? env.GATEWAY_MAX_SESSIONS ?? 8, 'GATEWAY_MAX_SESSIONS', 1, 1000);
  const connectTimeoutMs = readInteger(flags.connectTimeoutMs ?? env.GATEWAY_CONNECT_TIMEOUT_MS ?? 60000, 'GATEWAY_CONNECT_TIMEOUT_MS', 1, 3600000);
  const listTimeoutMs = readInteger(flags.listTimeoutMs ?? env.GATEWAY_LIST_TIMEOUT_MS ?? 60000, 'GATEWAY_LIST_TIMEOUT_MS', 1, 3600000);
  const callTimeoutMs = readInteger(flags.callTimeoutMs ?? env.GATEWAY_CALL_TIMEOUT_MS ?? 300000, 'GATEWAY_CALL_TIMEOUT_MS', 1, 3600000);

  return {
    apiKey,
    host,
    port,
    path,
    healthPath,
    backend: { command, args: backendArgs, cwd, env: backendEnv },
    allowedOrigins,
    sessionTtlMs,
    maxSessions,
    connectTimeoutMs,
    listTimeoutMs,
    callTimeoutMs,
    help: false
  };
}