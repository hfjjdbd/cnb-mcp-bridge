# Security and privacy

- Do not commit credentials, endpoint-specific configuration, personal paths, logs, private repository names, or production container identifiers.
- Keep API keys outside the checkout, or inject them through a client-managed environment. The ignore file is a guardrail, not a substitute for reviewing the exact files and Git history before publishing.
- Use HTTPS. HTTP is accepted only for loopback development. Redirects are rejected so a connection key is not automatically forwarded elsewhere.
- The adapter is a tools bridge, not a sandbox or authorization layer. A remote tool may read, write, or execute with the server account's permissions. Share access only with intended clients.
- Shared backends can expose shared process lists and files. Separate credentials alone do not establish tenant isolation; isolation must be implemented server-side.
- The CNB mode selects one exact configured repository, but repository selection is not cryptographic server identity verification. Protect the remote MCP key and control the configured endpoint.
- Tool results may contain sensitive information. The bridge does not censor valid tool output. Review what an agent is asked to read before sharing transcripts or logs.
- A timeout or disconnection does not prove that a tool failed to execute. Do not automatically replay mutations.

When reporting a defect, use a minimal reproduction with synthetic data. Never put real keys, personal data, private repository names, or live infrastructure identifiers in a public issue. Use GitHub's private vulnerability reporting feature if the repository exposes it; otherwise contact the maintainer privately before sharing sensitive details.
