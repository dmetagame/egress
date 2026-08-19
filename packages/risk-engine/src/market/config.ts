import type { Address } from "viem";

export interface XLayerProtocolConfig {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  forkBlock: bigint;
  contracts: {
    addressesProvider: Address;
    aavePool: Address;
    aaveOracle: Address;
    xbEthOracleSource: Address;
    xethOracleSource: Address;
    xbEth: Address;
    xeth: Address;
    aXbEth: Address;
    variableDebtXeth: Address;
    uniswapFactory: Address;
    swapRouter: Address;
    quoterV2: Address;
    swapPool: Address;
  };
  poolFee: number;
  tokenDecimals: number;
  oracleDecimals: number;
}

export const XLAYER_MAINNET: XLayerProtocolConfig = {
  chainId: 196,
  rpcUrl: "https://rpc.xlayer.tech",
  explorerUrl: "https://www.oklink.com/x-layer",
  forkBlock: 67_881_241n,
  contracts: {
    addressesProvider: "0xdFf435BCcf782f11187D3a4454d96702eD78e092" as Address,
    aavePool: "0xE3F3Caefdd7180F884c01E57f65Df979Af84f116" as Address,
    aaveOracle: "0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6" as Address,
    xbEthOracleSource: "0x2c54487c1a94b753987d980f98b13E8F313A7B44" as Address,
    xethOracleSource: "0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b" as Address,
    xbEth: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7" as Address,
    xeth: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A" as Address,
    aXbEth: "0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32" as Address,
    variableDebtXeth: "0xB756Fc7065369602f2cCb8356283E8b997fDfe2a" as Address,
    uniswapFactory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804" as Address,
    swapRouter: "0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA" as Address,
    quoterV2: "0xD1b797D92d87B688193A2B976eFc8D577D204343" as Address,
    swapPool: "0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc" as Address,
  },
  poolFee: 100,
  tokenDecimals: 18,
  oracleDecimals: 8,
};
