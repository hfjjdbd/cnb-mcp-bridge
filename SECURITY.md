# Security and privacy

- Do not commit credentials, endpoint-specific configuration, personal paths, logs, private repository names, or production container identifiers.
- Keep API keys outside the checkout, or inject them through a client-managed environment. The ignore file is a guardrail, not a substitute for reviewing the exact files and Git history before publishing.
- Use HTTPS. HTTP is accepted only for loopback development. Redirects are rejected so a connection key is not automatically forwarded elsewhere.
- The adapter is a tools bridge, not a sandbox or authorization layer. A remote tool may read, write, or execute with the server account's permissions. Share access only with intended clients.
- Shared backends can expose shared process lists and files. Separate credentials alone do not establish tenant isolation; isolation must be implemented server-side.
- The CNB mode selects one exact configured repository, but repository selection is not cryptographic server identity verification. Protect the remote MCP key and control the configured endpoint.
- Tool results may contain sensitive information. The bridge does not censor valid tool output. Review what an agent is asked to read before sharing transcripts or logs.
- A timeout or disconnection does not prove that a tool failed to execute. Do not automatically replay mutations.
- The self-hosted gateway must use a dedicated random MCP API key; do not reuse CNB, GitHub, SSH, model registry, or agent-provider credentials.
- Bind to loopback unless the hosting platform intentionally publishes the selected port. When binding externally, rely on platform HTTPS plus the gateway API key; do not expose the raw stdio backend.
- Browser `Origin` headers are rejected by default. Add only exact trusted origins when browser-based MCP is intentionally required.
- The health endpoint is intentionally unauthenticated and should expose only minimal liveness/state counts, never credentials, paths, commands, environment values, or tool output.
- Backend stderr is not forwarded to clients, and gateway configuration must not pass gateway key variables to the backend process.
- Stateful sessions are in-memory only. Session loss after a restart is expected; reconnect and inspect state before repeating mutations.

When reporting a defect, use a minimal reproduction with synthetic data. Never put real keys, personal data, private repository names, or live infrastructure identifiers in a public issue. Use GitHub's private vulnerability reporting feature if the repository exposes it; otherwise contact the maintainer privately before sharing sensitive details.