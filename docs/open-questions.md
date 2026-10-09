# Open questions

[← Project overview](./PROJECT.md)

- **Deployment:** SaaS only, or also self-hosted? A single-tenant option?
- **Hosted agents:** which model providers beyond Claude? Who pays for compute: users with their own API key, or platform billing?
- **Sandboxing:** where do hosted agents run code (Docker, E2B, Daytona…)?
- **Realtime sync:** stay with LISTEN/NOTIFY + SSE, or move to a local-first sync engine like Linear's?
- **Job queue:** pg-boss or Graphile Worker?
- **Pricing:** per human seat, with agents billed by usage?
- **Other Git providers:** GitLab and Bitbucket, and when?
- **Agent SDK on Bun:** confirm the Claude Agent SDK runs reliably under the Bun runtime, or run the worker on Node.
