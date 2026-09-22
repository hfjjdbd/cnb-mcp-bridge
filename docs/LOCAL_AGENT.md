# Local agent access to CNB workspaces

This guide describes the supported data path for controlling one or more CNB workspaces from a local MCP-capable agent without using Desktop Commander Hosted Remote as the tool-call relay.

## Network path

For each target workspace:

```text
local agent
  -> local stdio cnb-mcp-bridge
  -> public Internet / TLS
  -> https://<business-id>-8000.cnb.run/mcp
  -> CNB workspace edge
  -> cnb-mcp-gateway on workspace:8000
  -> local stdio MCP backend
```

The `*.cnb.run` URL is the CNB workspace public HTTPS address for the published port. The bridge can discover the current `business-id` through the CNB CLI so clients do not need to hard-code an address that changes after a rebuild.

Desktop Commander Hosted Remote may still run as an independent maintenance channel, but it is not part of the data path above.

## Requirements on each workspace

Each workspace should run one self-hosted gateway with:

- a pinned/verified `cnb-mcp-bridge` revision;
- a local stdio MCP backend;
- `GATEWAY_HOST=0.0.0.0` only when CNB is intentionally publishing the port;
- a dedicated random MCP API key stored outside Git with mode `0600`;
- an exact CNB edge Origin allowlist when Origin filtering is enabled;
- startup health checking.

Do not reuse CNB, GitHub, SSH, registry, or AI-provider credentials as the MCP key.

## Local client: two workspaces

Use one bridge process and one key file per target. The example below uses fictional repository names and paths:

```json
{
  "mcp": {
    "workspace_a": {
      "type": "local",
      "command": ["node", "/opt/cnb-mcp-bridge/bin/bridge.mjs"],
      "enabled": true,
      "environment": {
        "CNB_REPOSITORY": "example/workspace-a",
        "CNB_CLI_PATH": "/absolute/path/to/cnb.js",
        "MCP_API_KEY_FILE": "/secure/mcp/workspace-a.key"
      }
    },
    "workspace_b": {
      "type": "local",
      "command": ["node", "/opt/cnb-mcp-bridge/bin/bridge.mjs"],
      "enabled": true,
      "environment": {
        "CNB_REPOSITORY": "example/workspace-b",
        "CNB_CLI_PATH": "/absolute/path/to/cnb.js",
        "MCP_API_KEY_FILE": "/secure/mcp/workspace-b.key"
      }
    }
  }
}
```

Run `cnb login` on the local computer, or use a private `CNB_TOKEN_FILE` in non-interactive environments. CNB credentials are used only to discover the current workspace address. They are not the gateway credential.

Provision each MCP key to the local computer through a secure out-of-band channel and keep the two targets on different keys. Do not place key contents in agent configuration, shell history, screenshots, issue reports, or Git.

## Rebuild and reconnect

A workspace rebuild can change the CNB `business-id` and drops all in-memory MCP sessions.

1. Let the workspace startup hook restore/start the gateway.
2. Confirm `GET /healthz` locally inside the workspace.
3. Restart the local MCP client/bridge so CNB discovery resolves the new public address.
4. Re-initialize the MCP session.
5. Inspect remote state before retrying any mutation that was in flight when the connection failed.

Never assume a timed-out write failed; the gateway deliberately does not replay mutations.

## Key rotation

Rotate one workspace at a time.

1. Generate a new high-entropy random key on the target workspace.
2. Store it outside Git with mode `0600`.
3. Restart only that gateway with the new key.
4. Securely update the matching local client key file.
5. Reconnect and initialize a new session.
6. Remove obsolete copies of the old key.

Keys for different workspaces should remain independent.

## Security and privacy notes

The CNB endpoint is public-network reachable when the port is published. Security therefore depends on layered controls:

- CNB HTTPS/TLS protects transport in transit.
- The dedicated MCP API key is the primary client authentication control.
- API-key comparisons are constant-time.
- Browser Origin filtering is defense in depth. CNB currently rewrites/injects the forwarded Origin, so Origin must not be treated as client identity.
- Session TTL and session caps limit stale/abusive session accumulation.
- Request/tool timeouts do not trigger mutation replay.
- Gateway key variables are not passed to the stdio backend.
- Backend stderr is not forwarded to clients.
- `/healthz` is intentionally minimal and unauthenticated; it must not contain credentials, paths, commands, environment values, or tool output.
- Tool results are not censored. If an agent is allowed to read a secret file or environment variable, that data can be returned to the agent. The MCP gateway is not a sandbox or multi-tenant authorization layer.

Use separate OS/container permissions when stronger isolation is required.
