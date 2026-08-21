# Egress Judge Demo Script

Target runtime: approximately 3 minutes 10 seconds.

Core story: **LIVE X LAYER DATA -> RISK -> VALIDATION -> POLICY -> SIMULATION -> EVIDENCE -> READ-ONLY BOUNDARY**

The public production state is legitimate and complete when the observer is
fresh: LOW risk, a policy-rejected preview, and no broadcast capability. The
script must not claim `READY_FOR_CONFIRMATION` for a state the live API has not
actually reached. Show the real `PREVIEW_ONLY`, policy decision, and disabled
submission flags.

| Time | Narration | Screen / action | Judge takeaway |
| --- | --- | --- | --- |
| 00:00-00:07 | "This is Egress: a policy-bounded circuit breaker for xBETH-backed xETH debt on Aave X Layer." | Hold on the Egress title card. | The product and risk domain are clear immediately. |
| 00:07-00:31 | "The problem is not only seeing liquidation risk. It is responding early without giving an automated process arbitrary control over a user's position. Egress watches backing and redemption evidence, Aave health, oracle freshness, and executable liquidity. It then moves through detection, deterministic validation, and simulation before any supported write path." | Open the landing page and show the protection loop. | Egress is protection infrastructure, not an unrestricted trading bot. |
| 00:31-00:57 | "Now I am opening the live console. This view reads X Layer mainnet, chain 196, from a block-pinned archive. It is not a screenshot or a fabricated fixture. The current record exposes the observed block, snapshot status, and health factor. It also shows xBETH collateral, xETH debt, executable liquidity, and evidence-backed risk." | Open `/overview`; point to the live banner, chain, block, snapshot status, and metric row. | Mainnet observation and historical evidence are separate. |
| 00:57-01:19 | "The current observation is LOW risk, but the health factor is already below the configured protection boundary. That is a real state, not a forced demo alarm. Egress keeps the health boundary and the risk classification separate. The six checks show what Egress watches: xBETH backing, Aave health, executable liquidity, oracle freshness, policy readiness, and simulation." | Expand the six evidence checks and point to the health boundary. | The system distinguishes a triggered health boundary from a high-risk classification. |
| 01:19-01:47 | "The protection preview is deterministic. AI may help interpret a source revision, but it cannot choose an arbitrary token, amount, slippage limit, or contract. Those values are checked against the policy. In this real snapshot, the risk trigger and post-action health floor are not both satisfied. The policy rejects the proposed path, even though the health boundary is active. That refusal is the safety behavior." | Show the execution preview and failed policy checks. | AI interpretation does not become transaction authority. |
| 01:47-02:14 | "This production environment is intentionally read-only. The preview is not a transaction. Broadcast is disabled, transaction submitted is false, and execution staging is disabled. The operations page exposes database, archive, poller, RPC, oracle, indexed block, and lag. It states the hard boundary plainly: live mainnet execution is disabled." | Open `/operations`; show healthy service state and the disabled execution boundary. | The no-broadcast boundary is real and observable. |
| 02:14-02:46 | "For historical proof, I open the Phase 11 panel. This is X Layer testnet, chain 1952, not mainnet. Twenty-six of twenty-six records are safe-canonical and finalized-canonical under the publication policy. The panel exposes the deployment anchor, runtime verification, re-included sequences, and content hashes. This proves the execution architecture was exercised historically. It does not claim that the current mainnet observer executed anything." | Return to `/overview#phase11-evidence`; show `26 / 26 FINALIZED`, anchor, runtime verification, re-inclusions, and hashes. | Historical testnet execution proof is not presented as mainnet execution. |
| 02:46-03:10 | "The complete architecture begins with live observation and evidence-backed detection. It continues through deterministic validation, bounded simulation, and user-controlled authorization. An auditable boundary remains before any supported write path. Egress protects the decision before the market makes it. The public demo is at egress-opal.vercel.app. The implementation and historical evidence are on GitHub." | End on the title card with the public URLs. | The system is coherent, verifiable, and safety-conscious. |

## Rehearsal Notes

- Record only after `/api/live/current` is `COMPLETE` and `/api/health` reports healthy required services.
- If the observer is stale, show `DATA UNAVAILABLE` and explain that the system fails closed; never substitute historical values.
- Keep the browser at 1440x900 or 1440x1000 and hide browser chrome in the recording.
- Do not connect a wallet or click any signing, approval, registration, or transaction control.
- Do not say "autonomous execution," "mainnet execution," or "READY_FOR_CONFIRMATION" unless the exact live UI and API state support the statement.
- The current public release is expected to stop at `PREVIEW_ONLY` when the policy trigger is not met.
