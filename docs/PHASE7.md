# Egress Phase 7

> Historical verification record. Phase 8A subsequently identified a reviewed observation account and observed a fresh authoritative oracle round; see [PHASE8A.md](./PHASE8A.md).

## Objective

Replace demo-only market and position inputs with verifiable, read-only X Layer state while retaining the Phase 5 authorization and write boundary.

## Delivered

- Explicit read-only adapters for X Layer, protocol configuration, Aave, xBETH/xETH, Aave oracle feeds, Uniswap V3, and OKX X-RWA sources.
- Same-block reads for chain state, position, pool state, quote, and oracle values.
- Canonical `LiveRiskSnapshot` and deterministic `snapshotHash`.
- Per-adapter freshness, provenance, version, and redacted health logs.
- Fail-closed handling for missing accounts, stale feeds, unavailable sources, wrong chains, invalid bytecode/configuration, and unreproducible quotes.
- `GET /api/live` with no-store responses and a preview-only execution result.
- A live overview section that visibly distinguishes `LIVE READ-ONLY`, `REPLAY`, and `PINNED X LAYER FORK SIMULATION`.
- Environment and runtime-mode documentation.

## Verification boundary

Account-independent live verification can establish the current X Layer block, production protocol configuration, oracle contracts, Uniswap pool, and source pipeline. A complete position snapshot additionally requires an intentionally selected `EGRESS_LIVE_ACCOUNT` with a supported xBETH collateral/xETH debt position. The repository does not ship a default account and does not reuse the synthetic fork borrower as a live target.

When no account is configured, the service must return `LIVE_DATA_UNAVAILABLE` with partial facts and must not infer `LOW`, `NORMAL`, a protection status, or an execution preview. This is a deliberate safety result, not a UI fallback.

## Fresh live verification

The read-only endpoint was executed against X Layer mainnet on 2026-08-15. This is an observation record only; no signer was constructed and no transaction was submitted.

| Observation | Result |
|---|---|
| Chain | `196` |
| Block | `67,987,285` |
| Block hash | `0xee1a21e249677a12e903581ec2c67d9169a59cc88e12c83d28759e5670fe52b5` |
| RPC/configuration | `AVAILABLE` and matched the verified address book |
| xBETH/xETH Uniswap pool | `AVAILABLE`; `0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc`, fee `100` |
| OKX source pipeline | `AVAILABLE`; both allowlisted sources retrieved and unchanged from their stored revisions |
| Oracle observations | `STALE`; both feeds updated at `2026-08-14T18:01:37Z`, approximately `25,825` seconds old against a `21,600` second maximum |
| Observation account | Not configured; no wallet or fork borrower was inferred |
| Overall endpoint status | `LIVE_DATA_UNAVAILABLE` |

The source-only RWA adapter classified its current baseline as `NORMAL`, but that partial classification is not a live protection status. Because the oracle is stale and no supported position account is configured, the service correctly returns no complete risk status, policy decision, snapshot hash, or execution preview. A bounded scan of the latest 20,000 blocks also found no supported public xBETH-collateral/xETH-debt account suitable for silently selecting as the observation target.

## Acceptance matrix

| Requirement | Implementation/evidence |
|---|---|
| Real X Layer block | `XLayerReadAdapter`; chain and block freshness checks |
| Real Aave/configuration | `AaveReadAdapter` and `ProtocolConfigurationReadAdapter` |
| Real xBETH/xETH state | `XbEthReadAdapter` and Aave position reads |
| Real Uniswap liquidity | `UniswapReadAdapter`; factory/pool/token/fee verification and same-block quote |
| Oracle state | `OracleReadAdapter`; feed timestamps and source consistency |
| OKX evidence | `OkxRwaReadAdapter`; allowlist, revisions, diff, validation, freshness |
| Deterministic snapshot | `LiveRiskSnapshotService`; canonical hash and consistency checks |
| No live broadcast | `LIVE_READ_ONLY` preview schema and mode guards |
| Replay regression | Existing `/api/replay`, A/B/C fixtures, and Phase 5 fork artifact |
| Fork isolation | Existing Anvil scripts, chain/configuration checks, and explicit UI flag |

## Known limitation

The implementation is ready for a full live position read once a real supported public account is intentionally configured and the oracle meets the freshness policy. Until then, the live endpoint intentionally presents an unavailable state even if chain-level adapters are healthy. The overview is request-time rendered so its initial live state cannot be frozen at build time. Live mainnet autonomous broadcasting remains disabled.

## Next phase

The next phase should add a reviewed operator/demo workflow for selecting and validating an observation account, improve source retrieval resilience without weakening provenance checks, and only then consider a controlled testnet compatibility harness. It should not enable live-mainnet autonomous writes.
