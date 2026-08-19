import type { Address, PublicClient } from "viem";
import {
  aaveOracleAbi,
  oracleAggregatorAbi,
  priceCapAdapterAbi,
} from "../market/abis.js";
import { XLAYER_MAINNET } from "../market/config.js";
import { differenceBps } from "../market/math.js";
import {
  availableHealth,
  type AdapterHealth,
  type OracleFeedState,
  type OracleLiveState,
  unavailableHealth,
} from "./schemas.js";

export interface OracleAdapterResult {
  state: OracleLiveState | null;
  health: AdapterHealth;
}

interface FeedObservation {
  answer: bigint;
  updatedAt: bigint;
  roundId: bigint;
  decimals: number;
  description: string | null;
}

export class OracleReadAdapter {
  private readonly now: () => Date;
  private readonly maxAgeSeconds: number;

  constructor(
    private readonly client: PublicClient,
    options: { now?: () => Date; maxAgeSeconds?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxAgeSeconds = options.maxAgeSeconds ?? 21_600;
  }

  async read(blockNumber: bigint, blockTimestamp: Date): Promise<OracleAdapterResult> {
    const now = this.now();
    try {
      const [xbEthPrice, xethPrice, xbEthSource, xethSource] = await Promise.all([
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aaveOracle,
          abi: aaveOracleAbi,
          functionName: "getAssetPrice",
          args: [XLAYER_MAINNET.contracts.xbEth],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aaveOracle,
          abi: aaveOracleAbi,
          functionName: "getAssetPrice",
          args: [XLAYER_MAINNET.contracts.xeth],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aaveOracle,
          abi: aaveOracleAbi,
          functionName: "getSourceOfAsset",
          args: [XLAYER_MAINNET.contracts.xbEth],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aaveOracle,
          abi: aaveOracleAbi,
          functionName: "getSourceOfAsset",
          args: [XLAYER_MAINNET.contracts.xeth],
          blockNumber,
        }),
      ]);

      if (!sameAddress(xbEthSource, XLAYER_MAINNET.contracts.xbEthOracleSource)) {
        throw new Error("Aave xBETH oracle source does not match verified X Layer configuration.");
      }
      if (!sameAddress(xethSource, XLAYER_MAINNET.contracts.xethOracleSource)) {
        throw new Error("Aave xETH oracle source does not match verified X Layer configuration.");
      }
      const [xbEthFeed, xethFeed] = await Promise.all([
        this.readXbEthFeed(xbEthSource, BigInt(xbEthPrice), blockNumber),
        this.readChainlinkFeed(
          XLAYER_MAINNET.contracts.xeth,
          xethSource,
          BigInt(xethPrice),
          blockNumber,
          "CHAINLINK",
        ),
      ]);
      const sourceTimes = [xbEthFeed.updatedAt, xethFeed.updatedAt].map(
        (value) => new Date(Number(value) * 1000),
      );
      if (sourceTimes.some((value) => value.getTime() > blockTimestamp.getTime() + 5_000)) {
        throw new Error("Oracle source timestamp is later than the snapshot block.");
      }
      if (sourceTimes.some((value) => value.getTime() > now.getTime() + 5_000)) {
        throw new Error("Oracle source timestamp is in the future.");
      }
      const oldestSourceTime = sourceTimes.reduce((oldest, value) =>
        value.getTime() < oldest.getTime() ? value : oldest,
      );
      const sourceFreshness = sourceTimes.map((value) => {
        const ageSeconds = (now.getTime() - value.getTime()) / 1000;
        return ageSeconds >= -5 && ageSeconds <= this.maxAgeSeconds;
      });
      const health = availableHealth({
        adapter: "oracle",
        message: "Aave oracle prices and underlying feed timestamps were verified.",
        now,
        blockNumber,
        sourceTimestamp: oldestSourceTime,
        maxAgeSeconds: this.maxAgeSeconds,
        provenance: [
          XLAYER_MAINNET.contracts.aaveOracle,
          xbEthSource,
          xethSource,
          `block:${blockNumber.toString()}`,
        ],
      });
      const state: OracleLiveState = {
        xbEth: toFeedState(
          XLAYER_MAINNET.contracts.xbEth,
          xbEthSource,
          xbEthFeed,
          BigInt(xbEthPrice),
          sourceFreshness[0] ?? false,
        ),
        xeth: toFeedState(
          XLAYER_MAINNET.contracts.xeth,
          xethSource,
          xethFeed,
          BigInt(xethPrice),
          sourceFreshness[1] ?? false,
        ),
        maxAgeSeconds: this.maxAgeSeconds,
      };
      return { state, health };
    } catch (error) {
      return {
        state: null,
        health: unavailableHealth("oracle", errorMessage(error), now, {
          blockNumber,
          maxAgeSeconds: this.maxAgeSeconds,
        }),
      };
    }
  }

  private async readXbEthFeed(
    source: Address,
    priceBase: bigint,
    blockNumber: bigint,
  ): Promise<FeedObservation & { sourceKind: "CAPPED_RATIO"; ratio: bigint; snapshotRatio: bigint; snapshotTimestamp: bigint }> {
    const [baseAggregator, ratioProvider, ratio, snapshotRatio, snapshotTimestamp] =
      await Promise.all([
        this.client.readContract({
          address: source,
          abi: priceCapAdapterAbi,
          functionName: "BASE_TO_USD_AGGREGATOR",
          blockNumber,
        }),
        this.client.readContract({
          address: source,
          abi: priceCapAdapterAbi,
          functionName: "RATIO_PROVIDER",
          blockNumber,
        }),
        this.client.readContract({
          address: source,
          abi: priceCapAdapterAbi,
          functionName: "getRatio",
          blockNumber,
        }),
        this.client.readContract({
          address: source,
          abi: priceCapAdapterAbi,
          functionName: "getSnapshotRatio",
          blockNumber,
        }),
        this.client.readContract({
          address: source,
          abi: priceCapAdapterAbi,
          functionName: "getSnapshotTimestamp",
          blockNumber,
        }),
      ]);
    if (ratioProvider.toLowerCase() !== XLAYER_MAINNET.contracts.xbEth.toLowerCase()) {
      throw new Error("xBETH capped oracle ratio provider does not match configured xBETH.");
    }
    if (!sameAddress(baseAggregator, XLAYER_MAINNET.contracts.xethOracleSource)) {
      throw new Error("xBETH capped oracle base feed does not match the verified xETH source.");
    }
    const baseObservation = await this.readChainlinkObservation(baseAggregator, blockNumber);
    const impliedPrice = (baseObservation.answer * BigInt(ratio)) / 1_000_000_000_000_000_000n;
    if (differenceBps(impliedPrice, priceBase) > 5) {
      throw new Error("xBETH oracle price does not match its capped ratio source.");
    }
    return {
      ...baseObservation,
      sourceKind: "CAPPED_RATIO",
      ratio: BigInt(ratio),
      snapshotRatio: BigInt(snapshotRatio),
      snapshotTimestamp: BigInt(snapshotTimestamp),
    };
  }

  private async readChainlinkFeed(
    asset: Address,
    source: Address,
    priceBase: bigint,
    blockNumber: bigint,
    sourceKind: "CHAINLINK",
  ): Promise<FeedObservation & { sourceKind: "CHAINLINK"; ratio: null; snapshotRatio: null; snapshotTimestamp: null }> {
    const observation = await this.readChainlinkObservation(source, blockNumber);
    if (observation.answer <= 0n || observation.answer !== priceBase) {
      throw new Error(`Oracle answer mismatch for ${asset}.`);
    }
    return {
      ...observation,
      sourceKind,
      ratio: null,
      snapshotRatio: null,
      snapshotTimestamp: null,
    };
  }

  private async readChainlinkObservation(
    source: Address,
    blockNumber: bigint,
  ): Promise<FeedObservation> {
    const [round, decimals, description] = await Promise.all([
      this.client.readContract({
        address: source,
        abi: oracleAggregatorAbi,
        functionName: "latestRoundData",
        blockNumber,
      }),
      this.client.readContract({
        address: source,
        abi: oracleAggregatorAbi,
        functionName: "decimals",
        blockNumber,
      }),
      this.client.readContract({
        address: source,
        abi: oracleAggregatorAbi,
        functionName: "description",
        blockNumber,
      }).catch(() => null),
    ]);
    const [roundId, answer, , updatedAt] = round;
    if (answer <= 0n || updatedAt === 0n) {
      throw new Error(`Oracle source ${source} returned an invalid observation.`);
    }
    return {
      answer,
      updatedAt,
      roundId,
      decimals: Number(decimals),
      description,
    };
  }
}

function toFeedState(
  asset: Address,
  source: Address,
  observation: FeedObservation & {
    sourceKind: "CHAINLINK" | "CAPPED_RATIO";
    ratio: bigint | null;
    snapshotRatio: bigint | null;
    snapshotTimestamp: bigint | null;
  },
  priceBase: bigint,
  fresh: boolean,
): OracleFeedState {
  return {
    asset,
    oracle: XLAYER_MAINNET.contracts.aaveOracle,
    source,
    sourceKind: observation.sourceKind,
    priceBase: priceBase.toString(),
    decimals: observation.decimals,
    answer: observation.answer.toString(),
    updatedAt: new Date(Number(observation.updatedAt) * 1000).toISOString(),
    roundId: observation.roundId.toString(),
    sourceDescription: observation.description,
    ratio: observation.ratio?.toString() ?? null,
    snapshotRatio: observation.snapshotRatio?.toString() ?? null,
    snapshotTimestamp: observation.snapshotTimestamp
      ? new Date(Number(observation.snapshotTimestamp) * 1000).toISOString()
      : null,
    fresh,
    provenance: [XLAYER_MAINNET.contracts.aaveOracle, source],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
