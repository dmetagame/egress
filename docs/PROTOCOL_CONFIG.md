# X Layer protocol configuration

All addresses below are X Layer mainnet, chain `196`, and were validated at fork block `67,881,241`.

| Contract | Address | Verification |
|---|---|---|
| Aave PoolAddressesProvider | `0xdFf435BCcf782f11187D3a4454d96702eD78e092` | Aave address book; `getPool()` returns Pool |
| Aave Pool | `0xE3F3Caefdd7180F884c01E57f65Df979Af84f116` | Aave address book; fork execution |
| Aave Oracle | `0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6` | Aave address book; live price calls |
| xBETH Aave price source | `0x2c54487c1a94b753987d980f98b13E8F313A7B44` | `AaveOracle.getSourceOfAsset(xBETH)`; capped-ratio source |
| xETH Aave price source | `0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b` | `AaveOracle.getSourceOfAsset(xETH)`; ETH/USD aggregator |
| xBETH | `0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7` | Aave asset book; live bytecode |
| xETH | `0xE7B000003A45145decf8a28FC755aD5eC5EA025A` | Aave asset book; live bytecode |
| aXbETH | `0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32` | Data provider; permit and fork execution |
| xETH variable debt | `0xB756Fc7065369602f2cCb8356283E8b997fDfe2a` | Aave asset book; fork execution |
| Uniswap V3 Factory | `0x4B2ab38DBF28D31D467aA8993f6c2585981D6804` | Pool `factory()` and factory `getPool()` |
| SwapRouter02 | `0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA` | Live bytecode; router swap in fork |
| xBETH/xETH pool | `0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc` | Factory-derived; token/order/fee checks |

## Reserve values at pinned block

- xBETH: 67% LTV, 72% liquidation threshold, 7.5% standalone bonus
- xETH: 70% LTV, 75% liquidation threshold, 7.5% standalone bonus
- E-mode `5` (`xBETH__xETH`): 88% LTV, 90% liquidation threshold, 2% bonus
- Flash-loan premium: 5 bps
- All four relevant token decimals: 18

## Testnet

Current X Layer testnet is chain `1952`, with RPC `https://testrpc.xlayer.tech/terigon`. The known production addresses above returned empty bytecode on that network. Egress must use a clearly labelled compatibility harness for a testnet demo unless an official alternative deployment is verified.

## Live source verification

At X Layer block `68,048,783`, the Aave oracle still resolved the two configured asset sources above. The xBETH source reported the xBETH token as its ratio provider and the xETH source as its base USD aggregator. Egress fails closed if Aave changes either source until the new configuration is reviewed and recorded.
