# Security Policy

Egress handles financial risk evidence and bounded execution logic. The public
web application is read-only and must not receive private keys or transaction
submission credentials.

## Reporting

Please report suspected vulnerabilities through a private GitHub Security
Advisory for the repository, including reproduction steps, affected commit,
impact, and any relevant logs with credentials removed. Do not publish secrets
or exploit details in a public issue.

## Release Rules

- Never commit `.env` files, credentials, private keys, seed phrases, bearer
  tokens, database URLs with passwords, or RPC URLs containing credentials.
- Never put server-only values in `NEXT_PUBLIC_*` variables.
- Never enable mainnet write mode; it is unsupported.
- Keep deployment, observation, and execution-worker credentials in separate
  secret environments.
- Treat Phase 11 journal, reconciliation, and manifest files as immutable
  evidence. Do not rewrite them to repair a release.
- Report unavailable or stale financial data as unavailable. Do not fill gaps
  with synthetic values.
