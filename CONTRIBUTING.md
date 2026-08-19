# Contributing

Use Node `22.22.0` and npm `11.6.2`.

Before opening a change, run:

```bash
npm ci
npm run security:scan
npm run verify:phase11-evidence
npm run typecheck
npm run test:all
npm run build
npm run fmt:solidity:check
npm run test:solidity
```

Changes must preserve the read-only production boundary. Do not add a signer,
private-key path, mainnet transaction path, or browser secret. Do not modify
the Phase 11 journal, reconciliation artifact, or manifest. Changes to risk,
policy, database, or execution behavior require focused tests and a clear
explanation of the fail-closed impact.

Keep UI changes within the existing Egress design system and preserve reduced
motion, keyboard access, and explicit unavailable/error states.
