import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { describe, expect, it } from "vitest";
import { RiskAuditLogger } from "../src/audit/logger.js";
import {
  EGRESS_AUTHORIZATION_TYPES,
  egressAuthorizationDomain,
  executorAuthorizationMessage,
} from "../src/authorization/executor-typed-data.js";
import { EgressExecutionCoordinator } from "../src/execution/coordinator.js";
import { egressExecutorExecutionAbi } from "../src/execution/contract.js";
import { REPLAY_REVISIONS } from "../src/replay/fixtures.js";
import { InMemoryStore } from "../src/sources/store.js";
import {
  runRevision,
  TEST_ATTESTOR_ACCOUNT,
  TEST_NOW,
  TEST_USER_ACCOUNT,
} from "./helpers.js";

const TRANSACTION_HASH = `0x${"12".repeat(32)}` as Hex;
const AUTHORIZATION_HASH = `0x${"34".repeat(32)}` as Hex;
const EVENT_DATA_PARAMETERS = parseAbiParameters(
  "bytes32 authorizationHash,uint256 debtRepaid,uint256 collateralSold,uint256 swapOutput,uint256 flashPremium,uint256 surplusReturned,uint256 healthFactorBefore,uint256 healthFactorAfter",
);

async function materialRiskEvent(store: InMemoryStore) {
  await runRevision({ store, rawContent: REPLAY_REVISIONS.A });
  await runRevision({ store, rawContent: REPLAY_REVISIONS.B });
  const result = await runRevision({ store, rawContent: REPLAY_REVISIONS.C });
  if (!result.event?.intent?.authorization) throw new Error("Expected bounded intent");
  return result.event;
}

async function signAuthorization(event: Awaited<ReturnType<typeof materialRiskEvent>>) {
  return TEST_USER_ACCOUNT.signTypedData({
    domain: egressAuthorizationDomain({
      chainId: event.intent!.chainId,
      egressContract: event.intent!.egressContract as `0x${string}`,
    }),
    types: EGRESS_AUTHORIZATION_TYPES,
    primaryType: "Authorization",
    message: executorAuthorizationMessage(event.intent!.authorization!),
  });
}

function successfulReceipt(
  event: Awaited<ReturnType<typeof materialRiskEvent>>,
): TransactionReceipt {
  const authorization = event.intent!.authorization!;
  const topics = encodeEventTopics({
    abi: egressExecutorExecutionAbi,
    eventName: "Deleveraged",
    args: {
      user: authorization.user as `0x${string}`,
      executor: authorization.executor as `0x${string}`,
      nonce: BigInt(authorization.nonce),
    },
  });
  const swapOutput = BigInt(authorization.minSwapOut) + 1n;
  return {
    status: "success",
    transactionHash: TRANSACTION_HASH,
    transactionIndex: 0,
    blockHash: `0x${"56".repeat(32)}`,
    blockNumber: 67_881_250n,
    from: authorization.executor as `0x${string}`,
    to: event.intent!.egressContract as `0x${string}`,
    cumulativeGasUsed: 1_000_000n,
    gasUsed: 900_000n,
    effectiveGasPrice: 20_000_000n,
    contractAddress: null,
    logsBloom: `0x${"00".repeat(256)}`,
    type: "eip1559",
    logs: [
      {
        address: event.intent!.egressContract as `0x${string}`,
        blockHash: `0x${"56".repeat(32)}`,
        blockNumber: 67_881_250n,
        data: encodeAbiParameters(EVENT_DATA_PARAMETERS, [
          AUTHORIZATION_HASH,
          BigInt(authorization.repayAmount),
          BigInt(authorization.collateralAmount),
          swapOutput,
          1n,
          swapOutput - BigInt(authorization.repayAmount) - 1n,
          1_080_000_000_000_000_000n,
          1_210_000_000_000_000_000n,
        ]),
        logIndex: 0,
        removed: false,
        topics,
        transactionHash: TRANSACTION_HASH,
        transactionIndex: 0,
      },
    ],
  } as TransactionReceipt;
}

function clients(input: {
  event: Awaited<ReturnType<typeof materialRiskEvent>>;
  paused?: boolean;
  nonceUsed?: boolean;
  allowance?: bigint;
  simulateError?: Error;
}) {
  const simulated: unknown[] = [];
  const publicClient = {
    async getChainId() {
      return input.event.intent!.chainId;
    },
    async readContract(request: { functionName: string }) {
      if (request.functionName === "revocationNonces") {
        return BigInt(input.event.intent!.authorization!.revocationNonce);
      }
      if (request.functionName === "authorizationUsed") return input.nonceUsed ?? false;
      if (request.functionName === "paused") return input.paused ?? false;
      if (request.functionName === "allowance") {
        return input.allowance ?? BigInt(input.event.intent!.authorization!.collateralAmount);
      }
      throw new Error(`Unexpected contract read ${request.functionName}`);
    },
    async simulateContract(request: unknown) {
      if (input.simulateError) throw input.simulateError;
      simulated.push(request);
      return { request };
    },
    async waitForTransactionReceipt() {
      return successfulReceipt(input.event);
    },
  } as unknown as PublicClient;
  const walletClient = {
    async writeContract() {
      return TRANSACTION_HASH;
    },
  } as unknown as WalletClient;
  return { publicClient, walletClient, simulated };
}

function permitFor(event: Awaited<ReturnType<typeof materialRiskEvent>>) {
  return {
    deadline: BigInt(event.intent!.authorization!.deadline),
    signature: null,
  };
}

describe("Egress execution coordinator", () => {
  it("converts an approved risk event into the exact simulated Solidity request", async () => {
    const store = new InMemoryStore();
    const event = await materialRiskEvent(store);
    const signature = await signAuthorization(event);
    const mock = clients({ event });
    const coordinator = new EgressExecutionCoordinator({
      publicClient: mock.publicClient,
      executorAccount: event.policy.executor as `0x${string}`,
      auditLogger: new RiskAuditLogger(store),
      now: () => TEST_NOW,
    });

    const outcome = await coordinator.execute({
      event,
      userAuthorizationSignature: signature,
      collateralPermit: permitFor(event),
    });

    expect(outcome.event.intent?.status).toBe("READY_FOR_SUBMISSION");
    expect(outcome.event.executionResult?.status).toBe("SIMULATED");
    expect(outcome.request.authorization.repayAmount).toBe(
      BigInt(event.intent!.authorization!.repayAmount),
    );
    expect(outcome.request.authorization.collateralAmount).toBe(
      BigInt(event.intent!.authorization!.collateralAmount),
    );
    expect(mock.simulated).toHaveLength(1);
    expect((await store.getEvent(event.riskEventId))?.executionResult?.status).toBe(
      "SIMULATED",
    );
  });

  it("rejects a signature that does not bind the exact user authorization", async () => {
    const store = new InMemoryStore();
    const event = await materialRiskEvent(store);
    const authorization = event.intent!.authorization!;
    const signature = await TEST_ATTESTOR_ACCOUNT.signTypedData({
      domain: egressAuthorizationDomain({
        chainId: event.intent!.chainId,
        egressContract: event.intent!.egressContract as `0x${string}`,
      }),
      types: EGRESS_AUTHORIZATION_TYPES,
      primaryType: "Authorization",
      message: executorAuthorizationMessage(authorization),
    });
    const mock = clients({ event });
    const coordinator = new EgressExecutionCoordinator({
      publicClient: mock.publicClient,
      executorAccount: event.policy.executor as `0x${string}`,
      now: () => TEST_NOW,
    });

    await expect(
      coordinator.execute({
        event,
        userAuthorizationSignature: signature,
        collateralPermit: permitFor(event),
      }),
    ).rejects.toThrow(/exact execution intent/i);
    expect(mock.simulated).toHaveLength(0);
  });

  it("rechecks current pause and nonce state before simulation", async () => {
    const store = new InMemoryStore();
    const event = await materialRiskEvent(store);
    const signature = await signAuthorization(event);
    const mock = clients({ event, paused: true, nonceUsed: true });
    const coordinator = new EgressExecutionCoordinator({
      publicClient: mock.publicClient,
      executorAccount: event.policy.executor as `0x${string}`,
      now: () => TEST_NOW,
    });

    await expect(
      coordinator.execute({
        event,
        userAuthorizationSignature: signature,
        collateralPermit: permitFor(event),
      }),
    ).rejects.toThrow(/executor_unpaused|nonce_unused/i);
    expect(mock.simulated).toHaveLength(0);
  });

  it("broadcasts only non-live events and validates the Deleveraged receipt", async () => {
    const store = new InMemoryStore();
    const event = await materialRiskEvent(store);
    const signature = await signAuthorization(event);
    const mock = clients({ event });
    const coordinator = new EgressExecutionCoordinator({
      publicClient: mock.publicClient,
      walletClient: mock.walletClient,
      executorAccount: event.policy.executor as `0x${string}`,
      auditLogger: new RiskAuditLogger(store),
      now: () => TEST_NOW,
    });

    const outcome = await coordinator.execute({
      event,
      userAuthorizationSignature: signature,
      collateralPermit: permitFor(event),
      broadcast: true,
    });

    expect(outcome.event.executionResult?.status).toBe("CONFIRMED");
    expect(outcome.event.executionResult?.transactionHash).toBe(TRANSACTION_HASH);
    expect(outcome.event.executionResult?.deleveraged?.debtRepaidWei).toBe(
      event.intent!.authorization!.repayAmount,
    );
    expect(
      BigInt(outcome.event.executionResult!.deleveraged!.healthFactorAfterWad),
    ).toBeGreaterThan(
      BigInt(outcome.event.executionResult!.deleveraged!.healthFactorBeforeWad),
    );
    expect((await store.getEvent(event.riskEventId))?.executionResult?.status).toBe(
      "CONFIRMED",
    );
  });

  it("refuses to broadcast a live risk event even after successful simulation", async () => {
    const store = new InMemoryStore();
    const event = await materialRiskEvent(store);
    const liveEvent = { ...event, mode: "LIVE" as const };
    const signature = await signAuthorization(liveEvent);
    const mock = clients({ event: liveEvent });
    const coordinator = new EgressExecutionCoordinator({
      publicClient: mock.publicClient,
      walletClient: mock.walletClient,
      executorAccount: liveEvent.policy.executor as `0x${string}`,
      now: () => TEST_NOW,
    });

    await expect(
      coordinator.execute({
        event: liveEvent,
        userAuthorizationSignature: signature,
        collateralPermit: permitFor(liveEvent),
        broadcast: true,
      }),
    ).rejects.toThrow(/live-event broadcasting is intentionally disabled/i);
    expect(mock.simulated).toHaveLength(1);
  });

  it("records fail-closed simulation errors", async () => {
    const store = new InMemoryStore();
    const event = await materialRiskEvent(store);
    const signature = await signAuthorization(event);
    const mock = clients({ event, simulateError: new Error("unsafe post health factor") });
    const coordinator = new EgressExecutionCoordinator({
      publicClient: mock.publicClient,
      executorAccount: event.policy.executor as `0x${string}`,
      auditLogger: new RiskAuditLogger(store),
      now: () => TEST_NOW,
    });

    await expect(
      coordinator.execute({
        event,
        userAuthorizationSignature: signature,
        collateralPermit: permitFor(event),
      }),
    ).rejects.toThrow(/simulation failed/i);
    expect((await store.getEvent(event.riskEventId))?.executionResult?.status).toBe(
      "FAILED_VALIDATION",
    );
  });
});
