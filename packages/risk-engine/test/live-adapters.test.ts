import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { XLAYER_MAINNET } from "../src/market/config.js";
import { XLayerReadAdapter } from "../src/live/xlayer-adapter.js";
import { XbEthReadAdapter } from "../src/live/xbeth-adapter.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");

describe("live read-only adapters", () => {
  it("accepts the correct fresh X Layer chain and block", async () => {
    const client = {
      getChainId: async () => 196,
      getBlock: async () => ({
        number: 67_981_000n,
        hash: `0x${"ab".repeat(32)}`,
        timestamp: BigInt(Math.floor(NOW.getTime() / 1_000) - 10),
      }),
    } as unknown as PublicClient;
    const result = await new XLayerReadAdapter({ client, now: () => NOW }).read();
    expect(result.state?.chainId).toBe(196);
    expect(result.health.status).toBe("AVAILABLE");
    expect(result.health.freshness.fresh).toBe(true);
  });

  it("fails over to the next configured read-only RPC", async () => {
    const primary = {
      getChainId: async () => { throw new Error("primary unavailable"); },
    } as unknown as PublicClient;
    const secondary = {
      getChainId: async () => 196,
      getBlock: async () => ({
        number: 67_981_000n,
        hash: `0x${"bc".repeat(32)}`,
        timestamp: BigInt(Math.floor(NOW.getTime() / 1_000) - 5),
      }),
    } as unknown as PublicClient;
    const result = await new XLayerReadAdapter({
      clients: [primary, secondary],
      rpcUrls: ["https://primary.example/rpc", "https://secondary.example/rpc"],
      now: () => NOW,
    }).read();
    expect(result.state?.rpcUrl).toBe("https://secondary.example");
    expect(result.health.status).toBe("AVAILABLE");
    expect(result.client).toBe(secondary);
  });

  it("pins an observation to an exact block and verifies its hash", async () => {
    const blockHash = `0x${"12".repeat(32)}` as const;
    let blockRequest: { blockNumber?: bigint; blockTag?: string } | undefined;
    const client = {
      getChainId: async () => 196,
      getBlock: async (request: { blockNumber?: bigint; blockTag?: string }) => {
        blockRequest = request;
        return {
          number: 67_981_000n,
          hash: blockHash,
          timestamp: BigInt(Math.floor(NOW.getTime() / 1_000) - 10),
        };
      },
    } as unknown as PublicClient;
    const result = await new XLayerReadAdapter({
      client,
      now: () => NOW,
      observationBlockNumber: 67_981_000n,
      observationBlockHash: blockHash,
    }).read();

    expect(blockRequest).toEqual({ blockNumber: 67_981_000n });
    expect(result.state?.blockHash).toBe(blockHash);
    expect(result.health.status).toBe("AVAILABLE");
    expect(result.health.provenance).toContain("selection:pinned");
  });

  it("fails closed when a pinned block hash does not match", async () => {
    const client = {
      getChainId: async () => 196,
      getBlock: async () => ({
        number: 67_981_000n,
        hash: `0x${"34".repeat(32)}`,
        timestamp: BigInt(Math.floor(NOW.getTime() / 1_000) - 10),
      }),
    } as unknown as PublicClient;
    const result = await new XLayerReadAdapter({
      client,
      now: () => NOW,
      observationBlockNumber: 67_981_000n,
      observationBlockHash: `0x${"56".repeat(32)}`,
    }).read();

    expect(result.state).toBeNull();
    expect(result.health.status).toBe("INVALID_CONFIGURATION");
    expect(result.health.message).toMatch(/block hash/i);
  });

  it("redacts RPC credentials and path secrets from public provenance", async () => {
    const client = {
      getChainId: async () => 196,
      getBlock: async () => ({
        number: 67_981_000n,
        hash: `0x${"ef".repeat(32)}`,
        timestamp: BigInt(Math.floor(NOW.getTime() / 1_000)),
      }),
    } as unknown as PublicClient;
    const result = await new XLayerReadAdapter({
      client,
      now: () => NOW,
      rpcUrl: "https://account:secret@rpc.example/v2/private-key?token=hidden",
    }).read();
    expect(result.state?.rpcUrl).toBe("https://rpc.example");
    expect(result.health.provenance.join(" ")).not.toMatch(/secret|private-key|hidden/);
  });

  it("fails closed on the wrong chain and stale blocks", async () => {
    const wrongChain = {
      getChainId: async () => 1952,
    } as unknown as PublicClient;
    const wrong = await new XLayerReadAdapter({ client: wrongChain, now: () => NOW }).read();
    expect(wrong.state).toBeNull();
    expect(wrong.health.status).toBe("INVALID_CONFIGURATION");

    const staleClient = {
      getChainId: async () => 196,
      getBlock: async () => ({
        number: 67_981_000n,
        hash: `0x${"cd".repeat(32)}`,
        timestamp: BigInt(Math.floor(NOW.getTime() / 1_000) - 121),
      }),
    } as unknown as PublicClient;
    const stale = await new XLayerReadAdapter({ client: staleClient, now: () => NOW }).read();
    expect(stale.state).toBeNull();
    expect(stale.health.status).toBe("STALE");
  });

  it("reads the aXbETH allowance only for xBETH token state", async () => {
    const allowanceReads: string[] = [];
    const client = {
      readContract: async (request: { address: string; functionName: string }) => {
        if (request.functionName === "symbol") return request.address === XLAYER_MAINNET.contracts.xbEth ? "xBETH" : "xETH";
        if (request.functionName === "name") return request.address === XLAYER_MAINNET.contracts.xbEth ? "xBETH" : "xETH";
        if (request.functionName === "decimals") return 18;
        if (request.functionName === "balanceOf") return 1n;
        if (request.functionName === "allowance") {
          allowanceReads.push(request.address);
          return 2n;
        }
        throw new Error(`Unexpected ${request.functionName}`);
      },
    } as unknown as PublicClient;
    const adapter = new XbEthReadAdapter(client, {
      now: () => NOW,
      allowanceSpender: "0x1111111111111111111111111111111111111111",
    });
    const result = await adapter.read(
      "0x2222222222222222222222222222222222222222",
      67_981_000n,
      NOW,
    );
    expect(result.xbEth?.aTokenAllowanceWei).toBe("2");
    expect(result.xeth?.aTokenAllowanceWei).toBeNull();
    expect(allowanceReads).toEqual([XLAYER_MAINNET.contracts.aXbEth]);
  });
});
