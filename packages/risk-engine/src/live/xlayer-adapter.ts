import {
  createPublicClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
} from "viem";
import { XLAYER_MAINNET } from "../market/config.js";
import {
  availableHealth,
  type AdapterHealth,
  type XLayerBlockState,
  unavailableHealth,
} from "./schemas.js";

const xLayer = defineChain({
  id: XLAYER_MAINNET.chainId,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [XLAYER_MAINNET.rpcUrl] } },
  blockExplorers: {
    default: { name: "OKLink", url: XLAYER_MAINNET.explorerUrl },
  },
});

export interface XLayerAdapterResult {
  state: XLayerBlockState | null;
  health: AdapterHealth;
  client: PublicClient;
}

export class XLayerReadAdapter {
  private readonly clients: PublicClient[];
  private readonly rpcUrls: string[];
  private activeClient: PublicClient;
  private readonly now: () => Date;

  get client(): PublicClient {
    return this.activeClient;
  }

  constructor(
    private readonly options: {
      rpcUrl?: string;
      rpcUrls?: string[];
      expectedChainId?: number;
      maxBlockAgeSeconds?: number;
      observationBlockNumber?: bigint;
      observationBlockHash?: Hex;
      now?: () => Date;
      client?: PublicClient;
      clients?: PublicClient[];
    } = {},
  ) {
    const configuredRpcUrls = options.rpcUrls ?? (options.rpcUrl ? [options.rpcUrl] : [XLAYER_MAINNET.rpcUrl]);
    this.rpcUrls = [...new Set(configuredRpcUrls.map((value) => value.trim()).filter(Boolean))];
    if (this.rpcUrls.length === 0) this.rpcUrls.push(XLAYER_MAINNET.rpcUrl);
    this.clients = options.clients && options.clients.length > 0
      ? options.clients
      : options.client
        ? [options.client]
        : this.rpcUrls.map((rpcUrl) => createPublicClient({ chain: xLayer, transport: http(rpcUrl) }));
    this.activeClient = this.clients[0]!;
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<XLayerAdapterResult> {
    const now = this.now();
    const startedAt = Date.now();
    const expectedChainId = this.options.expectedChainId ?? XLAYER_MAINNET.chainId;
    if (
      this.options.observationBlockHash !== undefined &&
      this.options.observationBlockNumber === undefined
    ) {
      return {
        state: null,
        client: this.client,
        health: unavailableHealth(
          "xlayer",
          "An expected observation block hash requires an observation block number.",
          now,
          {
            maxAgeSeconds: this.options.maxBlockAgeSeconds ?? 120,
            status: "INVALID_CONFIGURATION",
          },
        ),
      };
    }
    if (this.options.observationBlockNumber !== undefined && this.options.observationBlockNumber < 0n) {
      return {
        state: null,
        client: this.client,
        health: unavailableHealth(
          "xlayer",
          "Observation block number cannot be negative.",
          now,
          {
            maxAgeSeconds: this.options.maxBlockAgeSeconds ?? 120,
            status: "INVALID_CONFIGURATION",
          },
        ),
      };
    }

    const failures: Array<{ message: string; health: AdapterHealth }> = [];
    for (let index = 0; index < this.clients.length; index += 1) {
      const client = this.clients[index]!;
      const result = await this.readFromClient(client, this.rpcUrls[index] ?? XLAYER_MAINNET.rpcUrl, now, startedAt, expectedChainId);
      if (result.state) {
        this.activeClient = client;
        return result;
      }
      failures.push({
        message: `${redactRpcUrl(this.rpcUrls[index] ?? XLAYER_MAINNET.rpcUrl)}: ${result.health.message}`,
        health: result.health,
      });
    }

    const last = failures.at(-1)?.message ?? "No RPC provider was configured.";
    const failureStatus = failures.some(({ health }) => health.status === "INVALID_CONFIGURATION")
      ? "INVALID_CONFIGURATION"
      : failures.some(({ health }) => health.status === "STALE")
        ? "STALE"
        : "UNAVAILABLE";
    return {
      state: null,
      client: this.activeClient,
      health: {
        ...unavailableHealth(
          "xlayer",
          `All configured X Layer RPC providers failed. ${failures.map(({ message }) => message).join(" | ")}`,
          now,
          { status: failureStatus },
        ),
        latencyMs: Date.now() - startedAt,
        provenance: failures.map(({ message }) => message.split(": ")[0] ?? message),
        message: `All configured X Layer RPC providers failed. ${last}`,
      },
    };
  }

  private async readFromClient(
    client: PublicClient,
    rpcUrl: string,
    now: Date,
    startedAt: number,
    expectedChainId: number,
  ): Promise<XLayerAdapterResult> {
    const publicRpcUrl = redactRpcUrl(rpcUrl);
    try {
      const chainId = await client.getChainId();
      if (chainId !== expectedChainId) {
        return {
          state: null,
          client,
          health: unavailableHealth(
            "xlayer",
            `Wrong chain: expected ${expectedChainId}, received ${chainId}.`,
            now,
            { maxAgeSeconds: this.options.maxBlockAgeSeconds ?? 120, status: "INVALID_CONFIGURATION" },
          ),
        };
      }

      const pinned = this.options.observationBlockNumber !== undefined;
      const block = pinned
        ? await client.getBlock({ blockNumber: this.options.observationBlockNumber })
        : await client.getBlock({ blockTag: "latest" });
      const blockHash = block.hash as Hex | null;
      if (!blockHash || block.number === null) {
        return {
          state: null,
          client,
          health: unavailableHealth("xlayer", "X Layer block did not include a hash and number.", now),
        };
      }
      if (
        this.options.observationBlockHash &&
        blockHash.toLowerCase() !== this.options.observationBlockHash.toLowerCase()
      ) {
        return {
          state: null,
          client,
          health: unavailableHealth(
            "xlayer",
            "Observation block hash does not match the configured expected hash.",
            now,
            {
              blockNumber: block.number,
              maxAgeSeconds: this.options.maxBlockAgeSeconds ?? 120,
              status: "INVALID_CONFIGURATION",
            },
          ),
        };
      }

      const blockTimestamp = new Date(Number(block.timestamp) * 1000);
      const ageSeconds = (now.getTime() - blockTimestamp.getTime()) / 1000;
      const maxBlockAgeSeconds = this.options.maxBlockAgeSeconds ?? 120;
      const provenance = [
        publicRpcUrl,
        `selection:${pinned ? "pinned" : "latest"}`,
        `block:${block.number.toString()}`,
        `hash:${blockHash}`,
      ];
      if (!Number.isFinite(ageSeconds) || ageSeconds < -5 || ageSeconds > maxBlockAgeSeconds) {
        const health = availableHealth({
          adapter: "xlayer",
          message: "X Layer block was retrieved.",
          now,
          blockNumber: block.number,
          sourceTimestamp: blockTimestamp,
          maxAgeSeconds: maxBlockAgeSeconds,
          provenance,
        });
        return {
          state: null,
          client,
          health: {
            ...health,
            status: "STALE",
            message: `${pinned ? "Pinned observation" : "Latest X Layer"} block is outside the ${maxBlockAgeSeconds}s freshness window.`,
          },
        };
      }

      const state: XLayerBlockState = {
        chainId,
        rpcUrl: publicRpcUrl,
        blockNumber: block.number.toString(),
        blockHash,
        blockTimestamp: blockTimestamp.toISOString(),
        rpcHealthy: true,
      };
      return {
        state,
        client,
        health: {
          ...availableHealth({
            adapter: "xlayer",
            message: pinned
              ? "X Layer RPC and pinned observation block are healthy."
              : "X Layer RPC and latest block are healthy.",
            now,
            blockNumber: block.number,
            sourceTimestamp: blockTimestamp,
            maxAgeSeconds: maxBlockAgeSeconds,
            provenance,
          }),
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      return {
        state: null,
        client,
        health: {
          ...unavailableHealth("xlayer", errorMessage(error), now),
          latencyMs: Date.now() - startedAt,
        },
      };
    }
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
  return message.replace(/https?:\/\/[^\s)]+/gu, (url) => redactRpcUrl(url));
}

function redactRpcUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return XLAYER_MAINNET.rpcUrl;
  }
}
