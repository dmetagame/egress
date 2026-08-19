# Egress Phase 8B

## Status

`PHASE 8B COMPLETE`

Phase 8B adds durable, immutable live observation storage and deterministic alerting around the completed Phase 8A read-only snapshot path. It does not change the risk model, contract authorization semantics, or execution modes. `LIVE_MAINNET` remains disabled.

## Implemented

- Stable canonical live-state serialization and hash identity;
- immutable filesystem archive for local operation/tests;
- direct Neon/PostgreSQL archive for hosted durable operation;
- append-only observation records for repeated reads of the same canonical state;
- explicit `COMPLETE`, `STALE`, `INVALID`, and `UNAVAILABLE` states;
- same-block and snapshot-integrity validation;
- conservative five-minute polling CLI with `--once` mode;
- deterministic Aave, oracle, liquidity, RWA source, position, configuration, and operational alerts;
- state-hash alert deduplication;
- `/api/live/current`, `/api/live/history`, and `/api/live/alerts`;
- current overview history, alerts, archive status, block/hash, snapshot hash, integrity hash, and provenance view.

## Storage

Local archive root:

```text
EGRESS_LIVE_ARCHIVE_PATH/
  snapshots/<hash>.json
  observations/<observation-id>.json
  alerts/<alert-id>.json
```

Hosted production requires `EGRESS_DATABASE_URL`; filesystem storage is rejected when the runtime is marked hosted. No ORM was introduced. PostgreSQL uses an explicit checked migration, immutable `ON CONFLICT DO NOTHING` inserts, and stores the complete validated JSON payload alongside indexed fields.

## Real live verification

Multiple one-shot and due polls were run with the public Phase 8A observation account `0x9772fedc43123a6efbd1965617d0e079de2689e4` against `https://rpc.xlayer.tech`. No signer, private key, permit, allowance, authorization, or transaction was created.

The initial archive baseline contains:

| Observation | Block | Status | Risk | Snapshot hash |
|---|---:|---|---|---|
| 1 | `68,053,231` | `COMPLETE` | `NORMAL` | `0xbe3b56809b28b2cb6e05421cfa99b49e85f30f1e87c10e500a0c65ad5170bc74` |
| 2 | `68,053,277` | `COMPLETE` | `NORMAL` | `0x2742ff9afe415c771a4de9cd38f8a88345e32c34afb57d169d338b7fbaa7c24b` |

Both observations used the verified X Layer chain `196`, same-block Aave/oracle/Uniswap reads, and official OKX evidence. The two records share configuration hash `0x900cbc1ee4dc4a7d95852d069925038628dcf1846c1d659057c985e8a6865328`, confirming block provenance does not itself create a configuration transition.

Representative post-build polling and API verification archived block `68,057,292` as `COMPLETE` and `CONSISTENT` with snapshot hash `0xa8b506a75a2c886b500ecb98f0692867d64a65be47ffae7bbc97d17bf035b907`. Snapshot integrity verification passed, the risk classification remained `NORMAL`, and both `broadcastPermitted` and `transactionSubmitted` remained `false`.

Representative verified position:

| Field | Value |
|---|---:|
| xBETH collateral | `344.37400463` |
| xETH debt | `300.728584491500630259` |
| health factor | `1.0438947532` |
| oracle age | approximately `18,093` seconds of `21,600` allowed |
| RWA classification | `NORMAL` |
| confidence | `0.98` |
| execution preview | `PREVIEW_ONLY`, policy rejected |
| broadcast permitted | `false` |
| transaction submitted | `false` |

The deterministic preview calculated a 10 xETH repayment cap, 11 xBETH collateral cap, expected output `11.128669103049042834` xETH, minimum output `11.017382412018552405` xETH, and projected health factor `1.0453114764`. It was not executable because the read-only planner policy and current liquidity could not reach its target floor. No execution was attempted.

The second observation emitted:

```text
DEBT_INCREASED       xETH debt accrued between Aave reads
HEALTH_FACTOR_DETERIORATED
```

Both alerts carry the current/previous snapshot hashes, block, exact Aave provenance, and previous/current values. No protocol configuration alert was emitted after configuration identity was corrected to exclude block-tag provenance.

## Tests and verification

Phase 8B-specific coverage includes:

- canonical identity stability and state-change hashing;
- immutable archive insertion, duplicate state recognition, append-only observations, tamper rejection;
- complete/stale/invalid/unavailable status mapping;
- same-block and configuration consistency;
- source revision versus risk transition separation;
- position/debt/collateral/health-factor transitions;
- alert evidence and deduplication;
- poller current-state behavior and runtime storage selection;
- web history, alerts, snapshot detail, unavailable state, and read-only flags.

The full regression commands are listed in the final report. Live mainnet broadcasting remains disabled by existing mode guards and no transaction was submitted during Phase 8B.

## Next phase

Phase 8C should focus on operational deployment hardening: managed Neon migrations/backup policy, authenticated operator controls for polling health (not execution), metrics/retention, alert delivery, and a controlled testnet/fork write harness only after those read-only controls are reviewed. It should not enable production autonomous mainnet execution.
