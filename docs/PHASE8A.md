# Egress Phase 8A

## Status

`PHASE 8A COMPLETE`

Egress produced a complete `LIVE_READ_ONLY` snapshot for a legitimate public X Layer Aave account. The observation was pinned to an exact recent block and hash, every required adapter returned `AVAILABLE`, the Aave oracle feed was inside the existing six-hour freshness limit, and no signer or transaction path was created.

## Observation account

Reviewed account:

```text
0x9772fedc43123a6efbd1965617d0e079de2689e4
```

Discovery used public OKX OnchainOS token-holder data as a candidate index:

```bash
onchainos token holders --chain xlayer \
  --address 0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32 \
  --limit 100 --max-results 500

onchainos token holders --chain xlayer \
  --address 0xB756Fc7065369602f2cCb8356283E8b997fDfe2a \
  --limit 100 --max-results 500
```

The account appeared as a holder of both aXbETH and variable-debt xETH. OnchainOS was used only for discovery; direct same-block RPC reads are authoritative. At block `68,048,783`, `eth_getCode` returned no runtime bytecode, so the account was an EOA at that block. Egress did not interact with it, impersonate it, sign for it, create an allowance, or submit a transaction.

The account is not configured as a repository default. Operators must deliberately provide it, or another independently reviewed account, through `EGRESS_LIVE_ACCOUNT`.

## Complete live observation

Observation time: `2026-08-15T18:17:09.051Z`

| Field | Value |
|---|---|
| Mode | `LIVE_READ_ONLY` |
| Status | `AVAILABLE` |
| Chain | `196` |
| Block | `68,048,783` |
| Block hash | `0x52d7332002df7c140bc5cdb88f994c8adeb7861ce666a94d9e8a964a5ba3aac8` |
| Block timestamp | `2026-08-15T18:16:59.000Z` |
| Snapshot hash | `0x43e7d9cfe0c6ce37850bb31c0b60f31452bd2dade42b2c4ee38f0b8ec5d3982e` |
| aXbETH collateral | `344.37400463` |
| xETH variable debt | `300.727653282296293493` |
| Health factor | `1.043897985621819824` |
| Liquidation threshold | `9000` bps |
| LTV | `8800` bps |
| Position scope | xBETH collateral + xETH debt only |
| RWA evidence | `AVAILABLE` |
| Current RWA classification | `NORMAL` |
| Evidence confidence | `0.98` |
| Broadcast permitted | `false` |
| Transaction submitted | `false` |

All onchain position, oracle, reserve, pool, and quote reads used block `68,048,783`. The block/hash pin is now an explicit adapter option and optional runtime configuration. A hash mismatch, wrong chain, stale block, or old pinned block fails closed.

## Oracle investigation

Aave configuration resolved:

| Role | Address |
|---|---|
| Aave oracle | `0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6` |
| xBETH source | `0x2c54487c1a94b753987d980f98b13E8F313A7B44` |
| xETH/base ETH-USD source | `0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b` |

At the observation block:

- xETH price: `188353887824` with 8 decimals;
- xBETH price: `190780131328` with 8 decimals;
- latest base-feed update: `2026-08-15T15:37:20.000Z`;
- feed age at observation: approximately `9,582` seconds;
- maximum accepted age: `21,600` seconds;
- current xBETH ratio: `1012881303020124354`;
- cap snapshot ratio: `1002354270813048698`;
- cap snapshot timestamp: `2026-03-03T11:57:16.000Z`.

The xBETH source is a capped-ratio adapter. Its March snapshot timestamp is a cap-model checkpoint, not the ETH/USD market-feed heartbeat. Egress verifies that the ratio provider is xBETH, the base aggregator is the same verified xETH source, and the implied ratio price agrees with `AaveOracle.getAssetPrice(xBETH)` within 5 bps. Market freshness is derived from the underlying ETH/USD round timestamp.

Recent authoritative rounds at the observation block were:

| Update | Answer |
|---|---:|
| `2026-08-15T15:37:20Z` | `188353887824` |
| `2026-08-15T09:04:37Z` | `187415705798` |
| `2026-08-15T03:14:25Z` | `188410068929` |
| `2026-08-14T18:01:37Z` | `187469631913` |

The Phase 7 stale result was genuine at its earlier observation time. A newer oracle round later arrived, so no freshness threshold was changed and no substitute price source was introduced. Aave's oracle returned the configured prices and exposes no age check through `getAssetPrice`; Egress therefore retains its independent six-hour fail-closed rule.

## Source of truth

| Value | Source | Method | Observation boundary | Freshness rule |
|---|---|---|---|---|
| X Layer block | X Layer RPC | `eth_chainId`, `eth_getBlockByNumber` | block `68,048,783`, exact hash | <= 120 seconds |
| xBETH collateral | aXbETH `0xe9e7...4d32` | `balanceOf(account)` | same block | snapshot block fresh |
| xETH debt | variable debt xETH `0xB756...e2a` | `balanceOf(account)` | same block | snapshot block fresh |
| Health factor/account totals | Aave Pool `0xE3F3...f116` | `getUserAccountData(account)` | same block | snapshot block fresh |
| xBETH/xETH prices | Aave Oracle `0x91FC...2C6` | `getAssetPrice`, `getSourceOfAsset` | same block | underlying round <= 21,600 seconds |
| Oracle timestamp | xETH source `0x8b85...907b` | `latestRoundData` | same block | not after block; <= 21,600 seconds |
| xBETH ratio/cap | source `0x2c54...7B44` | `getRatio`, `getSnapshotRatio`, `getSnapshotTimestamp` | same block | price must match verified base feed + ratio |
| Pool state/liquidity | pool `0x84d4...C8fc` | `slot0`, `liquidity`, token balances | same block | snapshot block fresh |
| Swap quote | Quoter V2 `0xD1b7...4343` | `quoteExactInputSingle` simulation | same block | reproducible quote; market policy <= 30 seconds |
| OKX RWA evidence | allowlisted OKX pages | bounded HTTPS retrieval, hash, revision, semantic diff | retrieval timestamps recorded | <= 86,400 seconds |

No adapter is allowed to silently redefine a shared value. The Aave position provider and oracle adapter must agree on both asset prices, and the quote must use the same account, assets, chain, pool, and block.

## RWA evidence

Both configured official sources were retrieved successfully and were unchanged from their stored revisions:

| Source | Revision | Content hash |
|---|---|---|
| `https://www.okx.com/x-rwa` | `rev_7545a398835fb68b` | `sha256:cd387eff08f7109c8243b82da435c23b74b3e3c15b65ef3ea31d0b222363e284` |
| `https://www.okx.com/help/how-does-xasset-work` | `rev_850d4fefd2fba7ac` | `sha256:798dccf906344d88078830c8472e7ccfec4386b192050bd1da5bca2c6189910f` |

The evidence validator returned valid evidence and the current deterministic fallback classification was `NORMAL`. This classification is a read-only observation, not an execution authorization.

## Deterministic preview

The complete snapshot produced a preview, but it did not permit an action:

| Field | Value |
|---|---:|
| Current health factor | `1.043897985621819824` |
| Preview target health factor | `1.2` |
| Proposed repayment | `10` xETH |
| Proposed collateral | `11` xBETH |
| Expected output | `11.128669103049042834` xETH |
| Minimum output | `11.017382412018552405` xETH |
| Estimated slippage | `8` bps |
| Flash premium ceiling | `0.005` xETH |
| Surplus at premium ceiling | `1.123669103049042834` xETH |
| Projected health factor | `1.045313244719734450` |
| Plan executable | `false` |
| Policy allowed | `false` |

The default live planner policy is explicitly preview-only. Its current caps cannot reach the `1.2` target, the RWA classification is below the HIGH trigger, and no signed attestation exists. The service therefore reports the bounded calculation and rejection reason without creating authorization or submitting a transaction.

## Security result

- No private key, wallet client, signature, permit, allowance, authorization, or live transaction was created.
- `LIVE_MAINNET` broadcasting remains disabled.
- The six-hour oracle threshold remains unchanged.
- A stale oracle, wrong asset source, source timestamp later than the block, malformed account, empty position, mixed Aave position, block-hash mismatch, or incomplete snapshot suppresses the execution preview.
- The UI continues to label the result `LIVE READ-ONLY` and `PREVIEW ONLY - NO TRANSACTION SUBMITTED`.
