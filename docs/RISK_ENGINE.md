# Egress RWA risk engine

## Scope

This milestone implements the intelligence and deterministic decision layer for one market only:

- OKX X-RWA/xBETH disclosures;
- xBETH collateral and variable xETH debt on Aave X Layer;
- xBETH to xETH liquidity through the configured Uniswap V3 pool;
- bounded calls into the manual and pre-authorized `EgressExecutor` formats.

It does not submit a live-mainnet transaction. It does not grant an LLM a wallet, key, arbitrary calldata, token choice, contract choice or amount choice.

## Decision path

```text
Allowlisted OKX source
        |
        v
raw + normalized, versioned snapshot
        |
        v
bounded semantic diff
        |
        v
structured AI claim extraction
        |
        v
deterministic evidence validation
        |
        v
independent risk-attestor signature
        |
        v
Aave position + oracle + Uniswap quote
        |
        v
deterministic user policy evaluation
        |
        v
bounded Egress EIP-712 authorization
        |
        v
manual exact signature or registered protection policy
        |
        v
existing EgressExecutor security boundary
```

## Source revisions

The initial registry contains:

- `https://www.okx.com/x-rwa`
- `https://www.okx.com/help/how-does-xasset-work`

Only exact allowlisted HTTPS host/path pairs are accepted. Every redirect target is checked before the next request. Responses must be HTML, are streamed through a 2 MB byte budget and time out by default after 15 seconds.

Each changed normalized document records:

- source URL and source ID;
- retrieval time and HTTP metadata;
- raw content and raw SHA-256 hash;
- normalized title, description, lines and content hash;
- monotonically increasing source version;
- previous revision ID;
- semantic diff ID;
- extraction lifecycle: `PENDING`, `ANALYZED`, `FAILED` or `SKIPPED`.

Unchanged normalized content creates no revision. A punctuation/format-only revision is stored and marked `SKIPPED`. Analyzer failures are stored as `FAILED` and yield `INSUFFICIENT_EVIDENCE` with no risk attestation.

Normalization is capped at 2,000 lines and 750 KB. The LCS semantic diff is capped at two million cells to bound memory and CPU exposure.

## Risk schema

The model must return `ModelRiskAnalysis`, not free prose. Each claim includes:

- `claimType`: backing, reserves, custody, redemption, conversion, withdrawal, staking, audit, proof of reserves, operational restriction, suspension, counterparty exposure, composition, settlement, delay, fee, eligibility, terms or other;
- `subject`: xBETH, X-RWA, OKX or other;
- exact statement, previous value, current value and change kind;
- `materiality` and position impact;
- one or more evidence references;
- confidence from 0 to 1.

An evidence reference fixes source ID, URL, revision ID, content hash, revision side, exact excerpt, section and line range.

The final `RiskVerdict` contains the validated claims, source/diff IDs, confidence, issuance/expiry, model identity, prompt version and all validation errors/warnings.

## Evidence validation

The validator is independent of the LLM. It checks:

- cited revisions exist;
- URL, source ID and content hash match the stored snapshot;
- `PREVIOUS`, `CURRENT` and `CORROBORATING` side labels match reality;
- line ranges and sections are exact;
- excerpts are verbatim;
- changed claims intersect the semantic diff;
- modified claims cite old and new revisions;
- added/modified claims provide a current value;
- removed/modified claims provide a previous value;
- values and statements contain no facts outside cited evidence;
- material risk does not exceed claim materiality;
- risk-relevant semantic changes cannot be silently returned as zero claims;
- explicit and independently detected cross-source contradictions fail closed.

Unsupported, contradictory or failed analysis becomes `INSUFFICIENT_EVIDENCE`. Uncertainty is never promoted to high risk.

## Materiality taxonomy

- `NORMAL`: first healthy baseline or no risk-relevant deterioration.
- `LOW`: clarification or non-substantive change with no plausible exit impairment.
- `MEDIUM`: bounded operational, fee, eligibility or delay change worth monitoring.
- `HIGH`: supported deterioration in backing, custody, redemption, conversion, withdrawal or exit conditions that could materially impair the position.
- `CRITICAL`: supported immediate or severe impairment, such as an explicit backing shortfall or indefinite redemption suspension.
- `INSUFFICIENT_EVIDENCE`: missing, contradictory, malformed, stale or unsupported evidence.

## AI inference

Production inference uses AI SDK v6 structured output:

```ts
generateText({
  model,
  output: Output.object({ schema: modelRiskAnalysisSchema }),
  prompt,
  temperature: 0,
});
```

Live configuration requires `EGRESS_AI_MODEL`. The default adapter uses Vercel AI Gateway; `EGRESS_AI_MODEL_VERSION` can pin or label an evaluated provider version. Provider credentials remain outside source snapshots and prompts.

Retrieved pages are placed inside an `UNTRUSTED_SOURCE_DATA` boundary. The prompt explicitly treats commands, role changes, secret requests and URLs in those pages as evidence text, never instructions.

Replay mode exercises the same ingestion, diff, evidence validation, verdict, signing, market and policy path. With `EGRESS_AI_MODEL` configured, it uses the production `AiSdkRiskAnalyzer` to analyze each revision. Without it, the CLI uses the explicitly recorded `DETERMINISTIC_REPLAY` fallback so the demo path remains reproducible offline; that fallback derives its classification from changed evidence rather than a revision label. AI SDK behavior has separate tests using `MockLanguageModelV3` and the production output schema.

## User policy schema

A `UserProtectionPolicy` fixes:

- user, approved executor, chain and Egress contract;
- approved independent risk attestor;
- risk and confidence thresholds;
- health-factor trigger, minimum and target;
- maximum repayment and collateral;
- maximum collateral percentage;
- maximum slippage, price impact and oracle/pool deviation;
- maximum flash-loan premium;
- cooldown and policy expiry;
- verdict, market and clock-skew freshness limits;
- automatic-execution preference;
- approved source IDs.

The policy engine is ordinary TypeScript. It invokes no model.

## Market and executor state

The X Layer adapter reads one block for:

- Aave account totals and health factor;
- aXbETH and xETH variable-debt balances;
- Aave xBETH and xETH oracle prices;
- Uniswap spot price, active liquidity and token balances;
- a Quoter V2 executable xBETH to xETH quote;
- gas price and an explicitly labelled execution-cost estimate.

Mixed Aave accounts fail closed because the health projection is intentionally single-market. The planner binary-searches for the smallest collateral sale that reaches the target health factor and fails if it cannot converge inside its bounded iteration budget.

The policy independently caps Uniswap/Aave-oracle deviation. A pool existing is not considered executable liquidity.

`XLayerExecutorStateProvider` reads the deployed executor's current `revocationNonces`, `authorizationUsed`, `paused` value and aXbETH allowance at one block. An exact aToken permit may satisfy collateral authorization instead of a standing allowance.

## Execution-intent schema

An `ExecutionIntent` records:

- allowed/rejected status and every deterministic check;
- risk event, verdict and policy IDs;
- creation and expiry;
- chain and fixed Egress contract;
- a nullable exact executor authorization;
- an object hash for audit correlation.

The authorization contains only contract-recognized limits: user, executor, repayment, collateral, tighter maxima, expected/minimum swap output, slippage, premium, post-health floor, deadline, nonce and current revocation epoch.

`AWAITING_USER_SIGNATURE` means the policy permits that exact bounded payload. `READY_FOR_SUBMISSION` additionally requires a valid user EIP-712 signature and exact permit/sufficient allowance. The execution coordinator re-reads current nonce, revocation, pause and allowance state, re-runs policy, verifies both signatures and requires a successful Solidity simulation. It may broadcast only explicit `TEST` or `REPLAY` events; `LIVE` broadcasting remains disabled.

Phase 5 adds an `OnchainProtectionPolicy`, `AutonomousRiskAttestation`, `AutonomousExecution` and `ShadowKeeperDecision`. The autonomous policy is signed and registered before an event. `EgressShadowKeeper` then refreshes market and policy state, derives amounts from the deterministic planner, and returns `WOULD_EXECUTE` only after the exact `executeAutonomous` call simulates. No post-event user signature is part of that request.

## Trust boundaries

- **Model:** interprets supplied evidence. It has no signer, key, wallet, RPC mutation or transaction tool.
- **Evidence validator:** independently rejects unsupported model output.
- **Risk attestor:** signs only a fully formed validated verdict for one policy. It is separate from the model provider.
- **Policy engine:** applies explicit user and market constraints without an LLM.
- **User:** chooses either the manual exact authorization or a position-specific pre-authorized policy plus setup allowance.
- **Solidity:** remains the final funds boundary and rechecks policy/attestation signatures, nonce, revocation, amounts, cumulative use, cooldown, oracle floor, premium, health factor, protocol identities and atomic repayment.

The manual Phase 4 path treats its attestation as provenance and still requires the exact user signature. The autonomous Phase 5 path verifies a separate policy-bound attestation onchain. That attestation can activate only a policy the user previously signed; it cannot expand policy limits or act as arbitrary spending authority.

## Audit records

Every evaluated revision produces a unique risk event containing source and diff IDs, the exact user policy and runtime state, model analysis and identity, structured verdict, evidence validation, attestation, position/liquidity state, bounded policy intent and execution status. Results progress through `NOT_SUBMITTED`, `SIMULATED`, `SUBMITTED`, `CONFIRMED`, `REVERTED` or `FAILED_VALIDATION`. A confirmed result stores the transaction hash, block, gas and parsed `Deleveraged` metrics.

## Replay scenarios

- Revision A: healthy baseline → `NORMAL` → rejected.
- Revision B: bounded maintenance delay → `MEDIUM` → rejected.
- Revision C: reserve-availability condition plus possible redemption suspension/material delay → `HIGH` → bounded intent awaiting user signature.

The generated replay artifact is `reports/risk-replay/replay.json` (at the repository root) and is clearly replay/test data, not a claim about a current OKX event or live user position.

The integrated pinned-fork artifacts are `reports/phase4/fork-control-loop.json` for manual exact authorization and `reports/phase5/autonomous-control-loop.json` for pre-authorized autonomous execution. Both use the deterministic replay analyzer for reproducibility while retaining the production ingestion, diff, evidence validation, market provider, deterministic planning and Solidity boundaries.
