import { isAddress, type Address, type PublicClient } from "viem";
import type { UserProtectionPolicy } from "../domain/schemas.js";
import { XLAYER_MAINNET } from "../market/config.js";
import { XLayerMarketContextProvider } from "../market/xlayer-provider.js";
import {
  unavailableHealth,
  type AdapterHealth,
  type LivePolicyState,
  type LiveRiskSnapshot,
  type LiveSnapshotEnvelope,
} from "./schemas.js";
import { AaveReadAdapter } from "./aave-adapter.js";
import { ProtocolConfigurationReadAdapter } from "./configuration-adapter.js";
import { OracleReadAdapter } from "./oracle-adapter.js";
import { OkxRwaReadAdapter } from "./rwa-adapter.js";
import { readOnlyPreviewPolicy } from "./preview-policy.js";
import { UniswapReadAdapter } from "./uniswap-adapter.js";
import { XLayerReadAdapter } from "./xlayer-adapter.js";
import { XbEthReadAdapter } from "./xbeth-adapter.js";
import { DeterministicPolicyEngine } from "../policy/engine.js";
import { executionIntentSchema } from "../domain/schemas.js";
import {
  defaultStorePath,
  JsonFileStore,
  type RevisionStore,
} from "../sources/store.js";
import { liveSnapshotStateHash } from "./canonical.js";

const ADAPTER_VERSIONS = {
  xlayer: "1",
  configuration: "1",
  aave: "1",
  xbeth: "1",
  oracle: "1",
  uniswap: "1",
  "uniswap-pool": "1",
  rwa: "1",
} as const;

export interface LiveSnapshotServiceOptions {
  rpcUrl?: string;
  rpcUrls?: string[];
  account?: Address | null;
  policy?: UserProtectionPolicy | null;
  client?: PublicClient;
  store?: RevisionStore;
  now?: () => Date;
  maxBlockAgeSeconds?: number;
  observationBlockNumber?: bigint;
  observationBlockHash?: `0x${string}`;
  maxOracleAgeSeconds?: number;
  maxSourceAgeSeconds?: number;
  egressSpender?: Address;
  rwaAdapter?: OkxRwaReadAdapter;
  configurationAdapter?: ProtocolConfigurationReadAdapter;
  oracleAdapter?: OracleReadAdapter;
  uniswapAdapter?: UniswapReadAdapter;
  aaveAdapter?: AaveReadAdapter;
  tokenAdapter?: XbEthReadAdapter;
  marketProvider?: XLayerMarketContextProvider;
}

export class LiveRiskSnapshotService {
  private readonly now: () => Date;
  private readonly xlayer: XLayerReadAdapter;
  private readonly store: RevisionStore;

  constructor(private readonly options: LiveSnapshotServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.xlayer = new XLayerReadAdapter({
      rpcUrl: options.rpcUrl,
      rpcUrls: options.rpcUrls,
      client: options.client,
      now: this.now,
      maxBlockAgeSeconds: options.maxBlockAgeSeconds,
      observationBlockNumber: options.observationBlockNumber,
      observationBlockHash: options.observationBlockHash,
    });
    this.store = options.store ?? new JsonFileStore(defaultStorePath());
  }

  async read(): Promise<LiveSnapshotEnvelope> {
    const requestedAt = this.now();
    const xlayerResult = await this.xlayer.read();
    const adapters: AdapterHealth[] = [xlayerResult.health];
    if (!xlayerResult.state) {
      return unavailableEnvelope(requestedAt, adapters, [xlayerResult.health.message]);
    }

    const blockNumber = BigInt(xlayerResult.state.blockNumber);
    const blockTimestamp = new Date(xlayerResult.state.blockTimestamp);
    const configuration =
      this.options.configurationAdapter ??
      new ProtocolConfigurationReadAdapter(this.xlayer.client, { now: this.now });
    const rwa =
      this.options.rwaAdapter ??
      new OkxRwaReadAdapter(this.store, {
        now: this.now,
        maxAgeSeconds: this.options.maxSourceAgeSeconds,
      });
    const oracle =
      this.options.oracleAdapter ??
      new OracleReadAdapter(this.xlayer.client, {
        now: this.now,
        maxAgeSeconds: this.options.maxOracleAgeSeconds,
      });
    const uniswap =
      this.options.uniswapAdapter ??
      new UniswapReadAdapter(this.xlayer.client, { now: this.now });
    const [configurationResult, rwaResult, oracleResult, uniswapPoolResult] = await Promise.all([
      configuration.read(blockNumber),
      rwa.read(),
      oracle.read(blockNumber, blockTimestamp),
      uniswap.readPool(blockNumber, blockTimestamp),
    ]);
    adapters.push(
      configurationResult.health,
      rwaResult.health,
      oracleResult.health,
      uniswapPoolResult.health,
    );

    const partialBase = {
      chain: xlayerResult.state,
      account: null,
      position: null,
      liquidity: null,
      oracle: oracleResult.state,
      uniswapPool: uniswapPoolResult.state,
      rwa: rwaResult.evidence,
      policy: null,
      executionPreview: null,
    } satisfies LiveSnapshotEnvelope["partial"];

    const account = this.options.account ?? null;
    if (!account) {
      const accountHealth = unavailableHealth(
        "account",
        "EGRESS_LIVE_ACCOUNT is not configured; no wallet position will be inferred.",
        requestedAt,
        { blockNumber, maxAgeSeconds: this.options.maxBlockAgeSeconds ?? 120 },
      );
      adapters.push(accountHealth);
      return unavailableEnvelope(
        requestedAt,
        adapters,
        [
          "LIVE_DATA_UNAVAILABLE: configure EGRESS_LIVE_ACCOUNT to read a supported Aave position.",
          ...adapters
            .filter((health) => health.status !== "AVAILABLE")
            .map((health) => health.message),
        ].filter(Boolean),
        partialBase,
      );
    }
    if (!isAddress(account)) {
      const accountHealth = unavailableHealth(
        "account",
        "EGRESS_LIVE_ACCOUNT is not a valid EVM address.",
        requestedAt,
        { blockNumber, maxAgeSeconds: this.options.maxBlockAgeSeconds ?? 120 },
      );
      adapters.push(accountHealth);
      return unavailableEnvelope(requestedAt, adapters, [accountHealth.message], partialBase);
    }

    const marketProvider =
      this.options.marketProvider ??
      new XLayerMarketContextProvider(XLAYER_MAINNET, {
        client: this.xlayer.client,
        now: this.now,
        plannerIterations: 32,
      });
    const aave =
      this.options.aaveAdapter ??
      new AaveReadAdapter(this.xlayer.client, { now: this.now, marketProvider });
    const tokenAdapter =
      this.options.tokenAdapter ??
      new XbEthReadAdapter(this.xlayer.client, {
        now: this.now,
        allowanceSpender: this.options.egressSpender,
      });
    const policy = this.options.policy ?? readOnlyPreviewPolicy(account, requestedAt);
    const policyState: LivePolicyState = {
      status: this.options.policy ? "PREVIEW_ONLY" : "PREVIEW_ONLY",
      policy,
      reason: this.options.policy
        ? "A policy was supplied to the read-only service; no live write authorization is inferred."
        : "Default planner limits are preview-only. No live Egress policy registration is verified.",
    };

    const [aaveResult, tokenResult] = await Promise.all([
      aave.read(account, blockNumber, blockTimestamp),
      tokenAdapter.read(account, blockNumber, blockTimestamp),
    ]);
    adapters.push(aaveResult.health, tokenResult.health);
    if (!aaveResult.state || !tokenResult.xbEth || !tokenResult.xeth || !oracleResult.state || !uniswapPoolResult.state) {
      return unavailableEnvelope(
        requestedAt,
        adapters,
        [
          aaveResult.health.message,
          tokenResult.health.message,
          oracleResult.health.message,
          rwaResult.evidence.status === "LIVE_DATA_UNAVAILABLE"
            ? "Official OKX RWA evidence is unavailable."
            : "",
        ].filter(Boolean),
        {
          ...partialBase,
          account,
          position: aaveResult.state?.position ?? null,
          liquidity: null,
          policy: policyState,
        },
      );
    }

    const quotedUniswap =
      this.options.uniswapAdapter ??
      new UniswapReadAdapter(this.xlayer.client, { now: this.now, marketProvider });
    const uniswapResult = await quotedUniswap.read(
      aaveResult.state.position,
      policy,
      blockNumber,
      blockTimestamp,
      uniswapPoolResult,
    );
    adapters.push(uniswapResult.health);
    if (!uniswapResult.state || !uniswapResult.market || !configurationResult.verified) {
      return unavailableEnvelope(
        requestedAt,
        adapters,
        [
          uniswapResult.health.message,
          ...configurationResult.reasons,
          rwaResult.evidence.status === "LIVE_DATA_UNAVAILABLE"
            ? "Official OKX RWA evidence is unavailable."
            : "",
        ].filter(Boolean),
        {
          ...partialBase,
          account,
          position: aaveResult.state.position,
          oracle: oracleResult.state,
          uniswapPool: uniswapPoolResult.state,
          liquidity: uniswapResult.market?.liquidity ?? null,
          policy: policyState,
        },
      );
    }

    const verifiedAave = aave.withConfigurationVerification(aaveResult.state, {
      addressesProviderVerified: configurationResult.verified,
      oracleAddressVerified: configurationResult.verified,
    });
    const marketContext = {
      position: verifiedAave.position,
      liquidity: uniswapResult.market.liquidity,
      plan: uniswapResult.market.plan,
    };
    const consistencyReasons = consistencyChecks({
      account,
      blockNumber,
      marketContext,
      oracle: oracleResult.state,
      tokenDecimals: [tokenResult.xbEth.decimals, tokenResult.xeth.decimals],
    });
    const requiredHealths = adapters.filter((health) => health.adapter !== "account");
    const allRequiredFresh =
      consistencyReasons.length === 0 &&
      rwaResult.evidence.status === "AVAILABLE" &&
      rwaResult.verdict !== null &&
      requiredHealths.every((health) => health.status === "AVAILABLE");
    if (!allRequiredFresh) {
      return unavailableEnvelope(
        requestedAt,
        adapters,
        [
          ...consistencyReasons,
          ...adapters.filter((health) => health.status !== "AVAILABLE").map((health) => health.message),
          rwaResult.evidence.status === "LIVE_DATA_UNAVAILABLE"
            ? "Official OKX RWA evidence is unavailable."
            : "",
        ].filter(Boolean),
        {
          ...partialBase,
          account,
          position: marketContext.position,
          liquidity: marketContext.liquidity,
          policy: policyState,
        },
      );
    }

    const generatedAt = this.now();
    const previewEvaluation = await new DeterministicPolicyEngine().evaluate({
      verdict: rwaResult.verdict!,
      attestation: null,
      market: marketContext,
      policy,
      runtime: {
        evaluatedAt: generatedAt.toISOString(),
        lastExecutionAt: null,
        authorizationNonce: "0",
        revocationNonce: "0",
        nonceAlreadyUsed: false,
        executorPaused: false,
        userAuthorizationSignature: null,
        collateralAuthorizationAvailable: false,
      },
    });
    const executionPreview = {
      status: "PREVIEW_ONLY" as const,
      plan: marketContext.plan,
      policyEvaluation: executionIntentSchema.parse(previewEvaluation),
      broadcastPermitted: false as const,
      transactionSubmitted: false as const,
      reason: "LIVE_READ_ONLY never creates a signer or submits a transaction.",
    };

    const baseSnapshot = {
      schemaVersion: 1 as const,
      mode: "LIVE_READ_ONLY" as const,
      generatedAt: generatedAt.toISOString(),
      chain: xlayerResult.state,
      account,
      aave: verifiedAave,
      tokens: { xbEth: tokenResult.xbEth, xeth: tokenResult.xeth },
      oracle: oracleResult.state,
      uniswap: uniswapResult.state,
      rwa: rwaResult.evidence,
      policy: policyState,
      marketContext,
      executionPreview,
      freshness: {
        maxBlockAgeSeconds: this.options.maxBlockAgeSeconds ?? 120,
        maxSourceAgeSeconds: this.options.maxSourceAgeSeconds ?? 86_400,
        allRequiredFresh: true,
      },
      adapters,
      adapterVersions: ADAPTER_VERSIONS,
    };
    const snapshotHash = liveSnapshotStateHash(baseSnapshot);
    const snapshot: LiveRiskSnapshot = { ...baseSnapshot, snapshotHash };
    return {
      mode: "LIVE_READ_ONLY",
      status: "AVAILABLE",
      generatedAt: generatedAt.toISOString(),
      snapshot,
      partial: {
        ...partialBase,
        account,
        position: marketContext.position,
        liquidity: marketContext.liquidity,
        policy: policyState,
        executionPreview,
      },
      adapters,
      reasons: [],
    };
  }
}

function consistencyChecks(input: {
  account: Address;
  blockNumber: bigint;
  marketContext: {
    position: {
      user: string;
      blockNumber: string;
      xbEthPriceBase: string;
      xethPriceBase: string;
      collateralBalanceWei: string;
      debtBalanceWei: string;
      singleMarketPosition: boolean;
    };
    liquidity: { blockNumber: string; chainId: number };
  };
  oracle: { xbEth: { priceBase: string }; xeth: { priceBase: string } };
  tokenDecimals: number[];
}): string[] {
  const reasons: string[] = [];
  if (input.marketContext.position.user.toLowerCase() !== input.account.toLowerCase()) {
    reasons.push("Aave position account does not match requested account.");
  }
  if (input.marketContext.position.blockNumber !== input.blockNumber.toString()) {
    reasons.push("Aave position was not read at the snapshot block.");
  }
  if (input.marketContext.liquidity.blockNumber !== input.blockNumber.toString()) {
    reasons.push("Uniswap quote was not read at the snapshot block.");
  }
  if (input.marketContext.position.xbEthPriceBase !== input.oracle.xbEth.priceBase) {
    reasons.push("Aave position xBETH price disagrees with oracle adapter.");
  }
  if (input.marketContext.position.xethPriceBase !== input.oracle.xeth.priceBase) {
    reasons.push("Aave position xETH price disagrees with oracle adapter.");
  }
  if (input.tokenDecimals.some((decimals) => decimals !== 18)) {
    reasons.push("Supported tokens do not all use 18 decimals.");
  }
  if (
    input.marketContext.position.collateralBalanceWei === "0" ||
    input.marketContext.position.debtBalanceWei === "0"
  ) {
    reasons.push(
      "Configured account does not contain a supported xBETH collateral and xETH debt position.",
    );
  }
  if (!input.marketContext.position.singleMarketPosition) {
    reasons.push("Configured account has additional Aave exposure outside the supported xBETH/xETH market.");
  }
  return reasons;
}

function unavailableEnvelope(
  generatedAt: Date,
  adapters: AdapterHealth[],
  reasons: string[],
  partial: Partial<LiveSnapshotEnvelope["partial"]> = {},
): LiveSnapshotEnvelope {
  const completePartial: LiveSnapshotEnvelope["partial"] = {
    chain: null,
    account: null,
    position: null,
    liquidity: null,
    oracle: null,
    uniswapPool: null,
    rwa: null,
    policy: null,
    executionPreview: null,
    ...partial,
  };
  return {
    mode: "LIVE_READ_ONLY",
    status: "LIVE_DATA_UNAVAILABLE",
    generatedAt: generatedAt.toISOString(),
    snapshot: null,
    partial: completePartial,
    adapters,
    reasons: [...new Set(reasons.filter(Boolean))],
  };
}
