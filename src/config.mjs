import fs from 'node:fs';

export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('MCP_ENDPOINT must be an absolute URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS, or HTTP on a loopback address for local development');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Put credentials in headers, not the endpoint URL');
  }
  return url;
}

export function selectWorkspace(payload, repository) {
  const matches = (payload.data?.list || []).filter(item => item.slug === repository && item.status === 'running');
  if (matches.length !== 1) throw new Error('CNB discovery requires exactly one running workspace for the configured repository');
  if (!/^[a-z0-9]+$/.test(matches[0].business_id || '')) throw new Error('Invalid CNB endpoint identifier');
  return matches[0];
}

export function loadConfig(env = process.env) {
  if (env.MCP_ENDPOINT && env.CNB_REPOSITORY) throw new Error('Choose MCP_ENDPOINT or CNB_REPOSITORY, not both');
  if (!env.MCP_ENDPOINT && !env.CNB_REPOSITORY) throw new Error('Set MCP_ENDPOINT or CNB_REPOSITORY');
  if (env.MCP_API_KEY && env.MCP_API_KEY_FILE) throw new Error('Choose MCP_API_KEY or MCP_API_KEY_FILE, not both');
  let apiKey = env.MCP_API_KEY || '';
  if (env.MCP_API_KEY_FILE) {
    try { apiKey = fs.readFileSync(env.MCP_API_KEY_FILE, 'utf8').trim(); }
    catch { throw new Error('Cannot read MCP_API_KEY_FILE'); }
  }
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Provide a non-empty API key without line breaks');
  const header = env.MCP_AUTH_HEADER || 'X-API-Key';
  if (!/^[A-Za-z0-9-]+$/.test(header)) throw new Error('Invalid MCP_AUTH_HEADER');
  if (['host', 'content-length', 'connection', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'].includes(header.toLowerCase())) {
    throw new Error('MCP_AUTH_HEADER cannot replace transport headers');
  }
  const port = Number(env.CNB_MCP_PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CNB_MCP_PORT');
  if (env.CNB_REPOSITORY) {
    const parts = env.CNB_REPOSITORY.split('/');
    if (parts.length < 2 || parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Invalid CNB_REPOSITORY');
    if (!env.CNB_CLI_PATH) throw new Error('CNB discovery requires CNB_CLI_PATH pointing to the cnb.js entrypoint');
  }
  return {
    endpoint: env.MCP_ENDPOINT ? validateEndpoint(env.MCP_ENDPOINT) : undefined,
    repository: env.CNB_REPOSITORY,
    cliPath: env.CNB_CLI_PATH,
    port,
    headers: { [header]: apiKey }
  };
}
