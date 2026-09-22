import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { selectWorkspace, validateEndpoint } from './config.mjs';

const exec = promisify(execFile);

export async function resolveEndpoint(config) {
  if (config.endpoint) return config.endpoint;
  const env = { ...process.env };
  delete env.MCP_API_KEY;
  delete env.MCP_API_KEY_FILE;
  let payload;
  try {
    const { stdout } = await exec(process.execPath, [config.cliPath,
      'workspace', 'list-workspaces', '--status', 'running', '--slug', config.repository, '--verbose'
    ], { env, timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    payload = JSON.parse(stdout);
  } catch {
    // A CLI failure can contain inherited credentials. Do not relay raw output.
    throw new Error('CNB workspace discovery failed; check CLI configuration and authentication');
  }
  const workspace = selectWorkspace(payload, config.repository);
  return validateEndpoint(`https://${workspace.business_id}-${config.port}.cnb.run/mcp`);
}

export async function connect(config) {
  const endpoint = await resolveEndpoint(config);
  const client = new Client({ name: 'cnb-mcp-bridge', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: config.headers },
    // Never forward the connection key through a redirect to another origin.
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' })
  });
  try { await client.connect(transport, { timeout: 60000 }); }
  catch {
    await transport.close();
    throw new Error('Cannot connect to the configured MCP endpoint; check availability and authentication');
  }
  return { client, transport };
}

export async function disconnect(connection) {
  if (!connection) return;
  try { await connection.transport.terminateSession(); } catch {}
  await connection.client.close();
}
