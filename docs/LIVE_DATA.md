# Live read-only data

Phase 7 adds a read-only data path for the supported xBETH collateral and xETH debt market on X Layer mainnet. The path is deliberately separate from the replay and fork-write paths.

```text
X Layer block
  -> protocol configuration
  -> Aave position/reserves
  -> xBETH/xETH token state
  -> Aave oracle and feed observations
  -> Uniswap V3 pool and deterministic quote
  -> allowlisted OKX source revisions
  -> LiveRiskSnapshot
  -> preview-only policy evaluation
```

The service never constructs a wallet client, reads a private key, signs a transaction, or broadcasts a transaction.

## Sources and verified configuration

The production configuration is X Layer mainnet, chain `196`, with the addresses recorded in [PROTOCOL_CONFIG.md](./PROTOCOL_CONFIG.md). The live adapter validates the address book on every snapshot block:

- Aave `PoolAddressesProvider.getPool()` and `getPriceOracle()` must match the configured pool and oracle.
- The Uniswap factory must resolve the configured xBETH/xETH pool at fee tier `100`.
- Pool token order, factory, fee, token decimals, and bytecode must match the configuration.
- Aave reserve configuration and flash-loan premium are read at the same block as the position.

Allowlisted OKX sources:

| Source | URL | Use |
|---|---|---|
| OKX X-RWA overview | `https://www.okx.com/x-rwa` | General X-RWA and xBETH disclosures |
| OKX X-Asset documentation | `https://www.okx.com/help/how-does-xasset-work` | Deposit, withdrawal, conversion, and operational conditions |

The source adapter stores raw snapshots through the existing revision store, computes content hashes and semantic diffs, validates evidence, and exposes source revision IDs and hashes in the snapshot. A source that cannot be fetched, parsed, corroborated, or kept within its freshness window produces `LIVE_DATA_UNAVAILABLE`.

## Adapter responsibilities

| Adapter | Read-only responsibility | Fail-closed condition |
|---|---|---|
| `xlayer` | Chain ID, latest block, hash, timestamp, RPC health | Wrong chain, missing block identity, stale block, RPC failure |
| `configuration` | Aave address book, Uniswap factory resolution, token bytecode/decimals | Any configured address or bytecode mismatch |
| `aave` | User position, xBETH/xETH reserve configuration, flash-loan premium | Position or reserve read failure |
| `xbeth` | xBETH/xETH metadata, wallet balances, aXbETH allowance observation | Token metadata or balance read failure |
| `oracle` | Aave prices, underlying feed observations, xBETH ratio consistency | Invalid/stale feed, timestamp inconsistency, price mismatch |
| `uniswap-pool` | Pool identity, token order, fee, slot0, liquidity, balances | Pool identity or state mismatch |
| `uniswap` | Same-block deterministic quote, price impact, slippage, executable bounds | Quote cannot be reproduced or is not executable |
| `rwa` | Official source retrieval, revisioning, evidence extraction and validation | Source unavailable, stale, contradictory, or unsupported claim |

## Snapshot contract

`LiveRiskSnapshot` contains:

- `mode: LIVE_READ_ONLY` and `schemaVersion`;
- chain ID, block number, block hash, and block timestamp;
- the explicitly configured account, never an inferred account;
- Aave position and reserve state;
- xBETH/xETH token metadata and balances;
- oracle feeds, source addresses, timestamps, and freshness flags;
- Uniswap pool state and deterministic executable quote;
- OKX source revisions, diffs, evidence, verdict, and analyzer metadata;
- preview-only policy evaluation and bounded execution plan;
- adapter health/provenance, freshness limits, and adapter versions;
- `snapshotHash`, a Keccak hash of a canonical state-identity projection. Volatile retrieval times, adapter age counters, generated intent IDs, and relative preview deadlines are excluded; block/hash, position, oracle values and sources, liquidity/quote, RWA revisions/content hashes, policy limits, protocol configuration, and adapter versions remain included. The complete archived payload retains the excluded metadata for audit.

The block number is threaded through all chain reads. An optional block hash can also be supplied; a mismatch fails closed before any position preview is produced. Consistency checks reject an account mismatch, cross-block position or quote, oracle disagreement, unsupported extra Aave exposure, zero collateral/debt, or non-18-decimal supported assets.

## Observation account semantics

`EGRESS_LIVE_ACCOUNT` is the owner of the Aave account being observed. It can technically be an EOA or contract, but a complete Egress snapshot requires all of the following at one block:

- non-zero aXbETH balance;
- non-zero xETH variable-debt balance;
- `AavePool.getUserAccountData(account)` totals that agree with those two reserves within the configured isolation tolerance;
- no material collateral or debt exposure outside the supported xBETH/xETH market.

It is not a keeper, signer, token-holder-only address, or inferred authorization owner. Wallet xBETH/xETH balances and an existing aXbETH allowance are informational only. The repository deliberately ships no default observation account.

## Freshness

Defaults are intentionally conservative and can be overridden only through positive integer environment values:

| Data | Variable | Default |
|---|---|---:|
| Latest X Layer block and onchain state | `EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS` | 120 seconds |
| Aave oracle feeds | `EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS` | 21,600 seconds |
| OKX source evidence | `EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS` | 86,400 seconds |

Every adapter returns status, observed time, source time, age, block number, and provenance. A stale or unavailable required adapter prevents a complete snapshot. The UI displays `DATA UNAVAILABLE` and the reasons rather than a reassuring risk color.

## Runtime configuration

```dotenv
EGRESS_XLAYER_RPC_URL=https://rpc.xlayer.tech
EGRESS_LIVE_ACCOUNT=
EGRESS_LIVE_EGRESS_SPENDER=
EGRESS_LIVE_OBSERVATION_BLOCK=
EGRESS_LIVE_OBSERVATION_BLOCK_HASH=
EGRESS_RISK_STORE_PATH=
EGRESS_LIVE_ARCHIVE_PATH=
EGRESS_DATABASE_URL=
EGRESS_LIVE_POLL_INTERVAL_SECONDS=300
EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS=120
EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS=21600
EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS=86400
```

`EGRESS_LIVE_ACCOUNT` is required for a complete position snapshot. It is an observation target only; it is not a signing identity. `EGRESS_LIVE_EGRESS_SPENDER` is optional and is used only to report the existing aXbETH allowance for that account.
`EGRESS_LIVE_OBSERVATION_BLOCK` optionally pins all onchain reads to one recent block. `EGRESS_LIVE_OBSERVATION_BLOCK_HASH` optionally binds that block to its exact hash and is rejected unless the block number is also set. Pinning never bypasses the normal block freshness window; an old block remains unavailable for current-risk decisions.
`EGRESS_RISK_STORE_PATH` is a server-side revision-store path and is never sent to the browser. When empty, the web runtime uses `.data/egress-risk.json` under its working directory; deployments should set an explicit writable path.
`EGRESS_LIVE_ARCHIVE_PATH` selects the local immutable archive directory for development and tests. Hosted production rejects filesystem archiving and requires `EGRESS_DATABASE_URL` for Neon/PostgreSQL durability. `EGRESS_LIVE_POLL_INTERVAL_SECONDS` defaults to five minutes and cannot be configured below 60 seconds.

Do not put private keys, signatures, seed phrases, or wallet credentials in these variables. Local env files are ignored by the repository.

The overview route is request-time rendered because it reads the live snapshot on the server. The client refreshes the read-only endpoint periodically, but a build-time page artifact is never treated as current chain state.

## API and UI

`GET /api/live/current` returns the latest archived observation and its canonical snapshot. `GET /api/live/history` returns chronological observation summaries. `GET /api/live/alerts` returns deterministic, evidence-backed alerts. The compatibility endpoint `GET /api/live` returns the current archived envelope. Every endpoint uses `cache-control: no-store`; when the latest observation is unavailable or stale, it stays unavailable and history is never substituted as current.
