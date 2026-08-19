import type {
  ArchivedLiveSnapshot,
  LiveAlert,
  OnchainProtectionPolicy,
  LiveSnapshotEnvelope,
  RiskEventRecord,
  ShadowKeeperDecision,
  SourceDiff,
  SourceSnapshot,
} from "@egress/risk-engine";

export type LiveApiResponse = LiveSnapshotEnvelope;

export interface LiveCurrentApiResponse {
  mode: "LIVE_READ_ONLY";
  status: "COMPLETE" | "STALE" | "INVALID" | "UNAVAILABLE";
  snapshotHash: string | null;
  block: string | null;
  blockHash: string | null;
  timestamp: string;
  risk: {
    classification: string | null;
    evidenceStatus: string | null;
    confidence: number | null;
    summary: string | null;
  };
  freshness: ArchivedLiveSnapshot["freshness"] | null;
  provenance: string[];
  observation: { observationId: string; snapshotHash: string; observedAt: string } | null;
  snapshot: {
    snapshotHash: string;
    integrityHash: string;
    archiveStatus: ArchivedLiveSnapshot["archiveStatus"];
    consistencyStatus: ArchivedLiveSnapshot["consistencyStatus"];
    consistencyReasons: string[];
    integrityValid: boolean;
    observedBlock: string | null;
    blockHash: string | null;
    timestamp: string;
    sourceStates: Array<{
      sourceId: string;
      sourceUrl: string;
      revisionId: string;
      contentHash: string;
      retrievedAt: string;
    }>;
  } | null;
  envelope: LiveSnapshotEnvelope;
  reasons: string[];
  broadcastPermitted: false;
  transactionSubmitted: false;
}

export interface LiveHistoryItem {
  observationId: string;
  snapshotHash: string;
  status: ArchivedLiveSnapshot["archiveStatus"];
  block: string | null;
  blockHash: string | null;
  timestamp: string;
  riskClassification: string | null;
  healthFactorWad: string | null;
  collateralBalanceWei: string | null;
  debtBalanceWei: string | null;
  sourceRevisionIds: string[];
  integrityHash: string;
}

export interface LiveHistoryApiResponse {
  mode: "LIVE_READ_ONLY";
  items: LiveHistoryItem[];
}

export interface LiveAlertsApiResponse {
  mode: "LIVE_READ_ONLY";
  items: LiveAlert[];
}

export type RiskLevel =
  | "NORMAL"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL"
  | "INSUFFICIENT_EVIDENCE";

export type ReplayRevision = "A" | "B" | "C";

export interface ForkPosition {
  collateralWei: string;
  debtWei: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  liquidationThresholdBps: string;
  ltvBps: string;
  healthFactorWad: string;
}

export interface Phase5Artifact {
  label: string;
  schemaVersion: 1;
  generatedAt: string;
  mode: "EXECUTED_FORK";
  environment: {
    rpc: string;
    chainId: number;
    forkBlock: number;
    forkBlockHash: string;
    liveMainnetBroadcast: false;
  };
  actors: {
    user: string;
    keeper: string;
    riskAttestor: string;
  };
  contracts: Record<string, string | number> & {
    egressExecutor: string;
    aavePool: string;
    xbEth: string;
    xeth: string;
    aXbEth: string;
    swapPool: string;
    uniswapPoolFee: number;
  };
  authorization: {
    policyId: string;
    policy: OnchainProtectionPolicy;
    policySignature: string;
    registrationTransaction: string;
    permitNonceAfterSetup: string;
    postEventPermitNonce: string;
    noPostEventUserSignature: boolean;
  };
  revisions: Array<{
    revision: ReplayRevision;
    riskEventId: string;
    riskLevel: RiskLevel;
    intentStatus: string;
    sourceRevisionIds: string[];
    diffIds: string[];
    evidence: RiskEventRecord["verdict"]["claims"];
  }>;
  shadowDecision: ShadowKeeperDecision;
  positionBefore: ForkPosition;
  positionAfter: ForkPosition;
  execution: {
    transactionHash: string;
    blockNumber: string;
    gasUsed: string;
    deleveraged: {
      user: string;
      executor: string;
      executionNonce: string;
      executionHash: string;
      debtRepaidWei: string;
      collateralSoldWei: string;
      swapOutputWei: string;
      flashPremiumWei: string;
      surplusReturnedWei: string;
      healthFactorBeforeWad: string;
      healthFactorAfterWad: string;
    };
  };
  assertions: Record<string, boolean>;
}

export interface ActivityEntry {
  id: string;
  timestamp: string;
  type: "SOURCE" | "RISK" | "POLICY" | "SIMULATION" | "EXECUTION" | "POSITION";
  title: string;
  detail: string;
  status: "neutral" | "success" | "warning" | "danger";
  reference?: string;
}

export interface ProductSnapshot {
  label: string;
  generatedAt: string;
  environment: Phase5Artifact["environment"];
  contracts: Phase5Artifact["contracts"];
  actors: Phase5Artifact["actors"];
  authorization: Phase5Artifact["authorization"];
  position: {
    before: ForkPosition;
    after: ForkPosition;
  };
  market: ShadowKeeperDecision["market"];
  policyState: ShadowKeeperDecision["policyState"];
  policyChecks: ShadowKeeperDecision["checks"];
  shadowStatus: ShadowKeeperDecision["status"];
  revisions: Phase5Artifact["revisions"];
  execution: Phase5Artifact["execution"];
  assertions: Record<string, boolean>;
  activity: ActivityEntry[];
}

export interface ReplayApiResponse {
  revision: ReplayRevision;
  pipelineStatus: string;
  message: string;
  event: RiskEventRecord;
  snapshot: SourceSnapshot;
  diff: SourceDiff;
  autonomous:
    | {
      decision: ShadowKeeperDecision;
        execution: Phase5Artifact["execution"] | null;
        environment: Phase5Artifact["environment"];
        label: string;
      }
    | null;
}

export interface TypedPolicyResponse {
  environment: {
    label: string;
    chainId: number;
    contract: `0x${string}`;
  };
  policy: OnchainProtectionPolicy;
  policyId: `0x${string}`;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  primaryType: "ProtectionPolicy";
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
}
