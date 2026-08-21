# Submission Copy

## Project Name

Egress

## One-line description

An AI-powered, non-custodial circuit breaker for xBETH-backed xETH debt on Aave X Layer.

## Project Description

Egress monitors xBETH backing and redemption risk, Aave position health, oracle freshness, and executable xBETH/xETH liquidity for a selected position on X Layer. When evidence changes, AI-assisted analysis helps structure and explain the risk signal, but deterministic policy checks remain authoritative for every transaction-critical boundary: asset scope, repayment and collateral limits, health-factor thresholds, slippage, freshness, timing, and execution count.

The public deployment is intentionally read-only. It demonstrates live X Layer mainnet observation, evidence-backed risk classification, deterministic validation, bounded protection previews, simulation data, provenance, and a clear execution boundary. It does not create a signer, hold user funds, or broadcast a mainnet transaction. A user authorization and a separately isolated keeper path would be required before any supported execution environment could submit a bounded action.

Egress also publishes historical Phase 11 proof from the X Layer testnet compatibility deployment. That record contains 26 of 26 safe-canonical and finalized-canonical transactions, including deployment, runtime verification, policy registration, and re-inclusion reconciliation. It is historical testnet evidence and is clearly separated from the current live mainnet observer.

## Problem

xBETH-backed xETH debt can become vulnerable when backing, liquidity, oracle, or account-health conditions deteriorate. Monitoring alone is not enough: an unsafe response can worsen the position or exceed the user's intended scope. Egress focuses on the decision boundary before liquidation by combining evidence, deterministic constraints, and a bounded simulation.

## X Layer integration

- Live observer: X Layer mainnet, chain 196.
- Historical execution proof: X Layer testnet, chain 1952.
- Mainnet RPC provenance and same-block protocol reads are shown in the live console.
- Phase 11 evidence is available at `/api/deployment/phase11`.

## Demo limitation

The current public deployment stops at read-only preview and does not claim autonomous mainnet execution. The demo should show `PREVIEW_ONLY`, policy status, `Broadcast: DISABLED`, and `transactionSubmitted: false`. Do not describe the historical Phase 11 testnet records as mainnet transactions.

## Links

- Demo: <https://egress-opal.vercel.app>
- GitHub: <https://github.com/dmetagame/egress>
- Historical evidence endpoint: <https://egress-opal.vercel.app/api/deployment/phase11>

## Form field checklist

| Form field | Prepared value |
| --- | --- |
| Project Name | Egress |
| Project Description | Use the description above |
| Project URL | `https://egress-opal.vercel.app` |
| Github | `https://github.com/dmetagame/egress` |
| Email | User must provide |
| Telegram | User must provide or enter `N/A` if accepted by the form |
| X (Twitter) Handle | User must provide the dedicated official handle |
| X (Twitter) Post URL | Add after publishing the approved post |
