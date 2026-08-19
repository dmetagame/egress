# Security notes

## Implemented controls

- Immutable Aave Pool, provider, tokens, router, factory, pool and fee tier
- Constructor-time cross-checks against live protocol interfaces
- EIP-712 user authorization
- Exact EIP-2612 aXbETH permit
- Already-applied permits are accepted, preventing third-party permit submission from causing a denial of service.
- Authorization expiry
- Per-user nonce replay protection
- User revocation epoch
- Executor binding
- Maximum repayment and collateral fields
- Signed expected quote
- Signed minimum output
- Maximum slippage basis points
- Minimum post-action health factor
- Aave callback caller and initiator checks
- Flash-loan asset and amount checks
- Exact debt and collateral delta checks
- Reentrancy guard
- Guardian emergency pause
- Router allowance clearing
- New execution balances must be fully consumed, while any pre-existing executor balances must be restored unchanged.
- User-signed maximum flash-loan premium ceiling
- Atomic rollback tests
- Allowlisted authoritative-source fetching with preflight checks on every redirect hop, content-type validation, timeout and streamed size limits
- Versioned source snapshots and bounded semantic-diff resource use
- Structured AI output with exact evidence references
- Independent evidence grounding, old/new-value, statement and contradiction checks
- Fail-closed `INSUFFICIENT_EVIDENCE` state
- Separate risk-attestor and user signing roles
- Deterministic policy checks for freshness, health, liquidity, slippage, price impact and Aave-oracle/Uniswap deviation
- Live executor reads for revocation epoch, nonce use, pause and collateral allowance
- Exact EIP-712 executor authorization verification before submission readiness
- Canonical risk-event linkage across source, verdict, policy, market context, intent and transaction
- Mandatory contract simulation and receipt/event validation before a replay/test execution is accepted
- Hard prohibition on `LIVE` event broadcasting in the Phase 4 coordinator
- Explicit local-fork gas headroom that changes only the gas ceiling, never signed calldata or bounds
- One-wei tolerance for Aave variable-debt index rounding after `Pool.repay` has returned the exact flash amount
- EIP-712 position-specific protection policy registration
- Setup-time cumulative aXbETH allowance bounded by the signed collateral budget
- Onchain policy digest, policy nonce, revocation epoch and immutable protocol-config hash
- Onchain policy state for active/revoked status, execution count, cooldown and cumulative use
- Onchain risk-attestation signature, policy/event/verdict/evidence hashes, HIGH/CRITICAL threshold and freshness
- Onchain per-action, cumulative, percentage, debt-ceiling and health-factor bounds
- Onchain Aave-oracle-relative minimum swap-output floor in addition to quote slippage
- One-risk-event-per-policy replay protection
- Shadow keeper refresh, deterministic recalculation and mandatory autonomous-call simulation
- Live unattended broadcasting disabled; only explicit TEST/REPLAY fork execution is permitted

## Known limitations before production

- There is no independent audit.
- The pause guardian is immutable and has no fund movement or policy authority; guardian rotation is not yet implemented.
- The keeper pays gas in the MVP and has no reimbursement or incentive contract. Keeper rotation requires a fresh user policy registration.
- The setup-time allowance remains visible at the ERC-20 level after policy revocation. The immutable contract refuses revoked policies, but users must reset the token allowance separately if they require zero allowance.
- The autonomous path verifies attestation metadata and signatures onchain, but it cannot verify the truth of the OKX disclosure or the semantic correctness of the AI interpretation.
- In the legacy exact-intent path, the user signs the quote and minimum output. In the autonomous path, the keeper supplies a fresh quote, but the policy fixes the slippage and premium ceilings and the contract adds an Aave-oracle-relative output floor. A production keeper must refresh the quote immediately before simulation and submit promptly.
- Aave variable-debt balances accrue between blocks. Reports distinguish the exact amount returned by `Pool.repay`/emitted by Egress from net debt-balance reduction observed in a later confirmation block.
- The autonomous contract reads the immutable Aave oracle and enforces the signed oracle-relative output floor. Offchain price-impact and liquidity checks remain necessary because pool depth and MEV are dynamic.
- The risk attestor is a single operational signer in this milestone; production requires HSM/KMS custody, rotation and incident response.
- Source authority is based on an allowlisted URL. DNS/TLS/platform compromise and legitimate-but-incorrect issuer disclosures remain outside Egress's proof boundary.
- Mainnet deployment must wait for organizer strategy approval, code review and audit-grade testing.

## Threat review

| Threat | Impact | Mitigation | Remaining risk |
| --- | --- | --- | --- |
| Prompt injection in an OKX page | Model follows source text as commands | Page is delimited as untrusted evidence; model receives no wallet/tool; structured schema and independent evidence validation | A sophisticated injection may still degrade classification, causing fail-closed monitoring gaps |
| Malicious or compromised source content | False risk/no-risk claims | Exact allowlist, revisions, hashes, audit trail, corroborating-source conflict checks | Egress cannot prove the truthfulness of an authoritative disclosure |
| Hallucinated excerpt/value/statement | Unsupported trigger | Verbatim line lookup, source metadata checks and token-level grounding | Grounded but semantically wrong interpretation remains possible |
| Stale or future-dated data | Action on obsolete/manipulated state | Verdict/market TTLs and bounded clock skew; one-block market reads; intent expiry | Chain reorg or latency inside the allowed window |
| Replay or revoked authorization | Repeated/obsolete spend | Onchain nonce and revocation epoch; live offchain reads; user EIP-712 signature | RPC inconsistency before submission; Solidity remains final authority |
| Compromised risk-attestor key | False HIGH/CRITICAL event | Policy-pinned signer, onchain signature/freshness/hash checks, health trigger, amount/oracle/HF bounds | An attacker can cause an unnecessary action within the user's registered limits |
| Incorrect user policy | Unwanted but authorized bounds | Explicit schemas, bounded caps, human-readable checks, user signs final payload | Users can deliberately choose unsafe thresholds |
| Oracle/DEX manipulation | Unsafe quote or health projection | Aave oracle-relative output floor, quote slippage, price-impact/deviation checks, fresh quote, atomic rollback | A manipulated oracle can still provide a bad reference; Aave oracle governance remains outside Egress |
| Liquidity disappearance/MEV | Swap cannot repay flash loan | Minimum output, premium coverage and atomic rollback | Transaction may revert and consume gas |
| Source or model denial of service | Missed event | Timeouts, status lifecycle, fail closed, deterministic replay for demo | No automatic execution during outage; monitoring availability needs redundancy |
| Conflicting evidence | False confidence | Explicit model conflict field plus deterministic cross-source polarity checks | Nuanced conflicts can evade keyword-level checks and require review |

## Phase 5 threat review

| Threat | Attack path | Contract defense | Offchain defense | Residual risk |
| --- | --- | --- | --- | --- |
| Malicious keeper | Changes repayment, collateral, quote, deadline, user or policy | Policy digest, keeper binding, per-action/cumulative caps, oracle floor, HF checks, Aave/Uniswap immutables | Recalculate from fresh state, simulate, receipt-validate | Keeper can submit an unnecessary bounded action if risk attestation and trigger conditions pass |
| Compromised AI | Labels every source revision HIGH | AI cannot sign policy or change limits; attestor/policy/market/health gates remain | Evidence validation, approved sources, freshness and human-configured thresholds | False positives can spend within the user's explicit policy |
| Compromised backend | Supplies stale or altered execution data | Contract uses current debt/HF/oracle and verifies policy/attestation hashes | One-block refresh, simulation and immutable audit records | A valid attestor/backend outage can prevent action; no liveness guarantee |
| Policy theft | Attacker copies policy/signature and submits it | Keeper address, policy nonce, expiry, revocation, execution count and event replay | Keep policy/signature storage private where practical | A stolen policy is still usable by the authorized keeper only |
| Front-running/MEV | Attacker observes a pending autonomous call | Minimum output, oracle floor and atomic flash-loan repayment | Private transaction routing can be added later; current MVP accepts public mempool risk | Transaction can revert or receive only the signed minimum |
| Keeper censorship | Keeper refuses to submit | User can replace policy/keeper with a fresh signature | Poller can alert and support a future redundant keeper set | No execution while all authorized keepers are unavailable |
