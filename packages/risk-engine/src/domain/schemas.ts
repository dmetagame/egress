import { z } from "zod";

export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const signatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export const uintStringSchema = z.string().regex(/^\d+$/);
export const isoTimestampSchema = z.string().datetime({ offset: true });

export const riskLevelSchema = z.enum([
  "NORMAL",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
  "INSUFFICIENT_EVIDENCE",
]);

export const materialRiskLevelSchema = z.enum([
  "NORMAL",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

export const claimTypeSchema = z.enum([
  "BACKING",
  "RESERVE_ASSETS",
  "CUSTODY",
  "REDEMPTION",
  "CONVERSION",
  "WITHDRAWAL",
  "STAKING",
  "AUDIT",
  "PROOF_OF_RESERVES",
  "OPERATIONAL_RESTRICTION",
  "SUSPENSION",
  "COUNTERPARTY_EXPOSURE",
  "ASSET_COMPOSITION",
  "SETTLEMENT",
  "DELAY",
  "FEE",
  "ELIGIBILITY",
  "TERMS",
  "OTHER",
]);

export const sourceDefinitionSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  authority: z.literal("OKX"),
  assetScope: z.array(z.enum(["X_RWA", "XBETH"])).min(1),
  enabled: z.boolean().default(true),
});

export const normalizedLineSchema = z.object({
  line: z.number().int().positive(),
  section: z.string().min(1),
  text: z.string().min(1),
});

export const normalizedDocumentSchema = z.object({
  title: z.string(),
  description: z.string(),
  text: z.string(),
  lines: z.array(normalizedLineSchema),
  semanticFingerprint: sha256Schema,
});

export const sourceSnapshotSchema = z.object({
  revisionId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceVersion: z.number().int().positive(),
  retrievedAt: isoTimestampSchema,
  contentHash: sha256Schema,
  rawContentHash: sha256Schema,
  rawContent: z.string(),
  normalized: normalizedDocumentSchema,
  previousRevisionId: z.string().nullable(),
  diffId: z.string().nullable(),
  extractionStatus: z.enum(["PENDING", "ANALYZED", "FAILED", "SKIPPED"]),
  responseMetadata: z.object({
    status: z.number().int(),
    contentType: z.string().nullable(),
    etag: z.string().nullable(),
    lastModified: z.string().nullable(),
    finalUrl: z.string().url(),
  }),
});

export const diffHunkSchema = z.object({
  hunkId: z.string().min(1),
  section: z.string().min(1),
  oldStartLine: z.number().int().nonnegative(),
  oldEndLine: z.number().int().nonnegative(),
  newStartLine: z.number().int().nonnegative(),
  newEndLine: z.number().int().nonnegative(),
  removedLines: z.array(z.string()),
  addedLines: z.array(z.string()),
});

export const sourceDiffSchema = z.object({
  diffId: z.string().min(1),
  sourceId: z.string().min(1),
  fromRevisionId: z.string().nullable(),
  toRevisionId: z.string().min(1),
  generatedAt: isoTimestampSchema,
  kind: z.enum(["INITIAL", "CHANGED"]),
  cosmeticOnly: z.boolean(),
  summary: z.string(),
  hunks: z.array(diffHunkSchema),
});

export const evidenceLocationSchema = z.object({
  section: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export const evidenceReferenceSchema = z.object({
  evidenceId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
  revisionId: z.string().min(1),
  contentHash: sha256Schema,
  side: z.enum(["PREVIOUS", "CURRENT", "CORROBORATING"]),
  excerpt: z.string().min(1),
  location: evidenceLocationSchema,
});

export const extractedClaimSchema = z.object({
  claimId: z.string().min(1),
  claimType: claimTypeSchema,
  subject: z.enum(["XBETH", "X_RWA", "OKX", "OTHER"]),
  statement: z.string().min(1),
  previousValue: z.string().nullable(),
  currentValue: z.string().nullable(),
  changeKind: z.enum(["ADDED", "REMOVED", "MODIFIED", "UNCHANGED"]),
  changeSummary: z.string(),
  materiality: materialRiskLevelSchema,
  positionImpact: z.string(),
  evidence: z.array(evidenceReferenceSchema).min(1),
  confidence: z.number().min(0).max(1),
});

export const modelRiskAnalysisSchema = z.object({
  proposedRiskLevel: riskLevelSchema,
  summary: z.string().min(1),
  rationale: z.string().min(1),
  claims: z.array(extractedClaimSchema),
  conflictingEvidence: z.boolean(),
  conflictExplanation: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const analyzerMetadataSchema = z.object({
  analyzer: z.enum(["AI_SDK", "DETERMINISTIC_REPLAY", "DETERMINISTIC_FILTER"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  analyzedAt: isoTimestampSchema,
});

export const evidenceValidationSchema = z.object({
  valid: z.boolean(),
  validatedEvidenceIds: z.array(z.string()),
  rejectedEvidenceIds: z.array(z.string()),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const riskVerdictSchema = z.object({
  verdictId: z.string().min(1),
  riskEventId: z.string().min(1),
  riskLevel: riskLevelSchema,
  material: z.boolean(),
  trigger: z.string(),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  sourceRevisionIds: z.array(z.string()).min(1),
  diffIds: z.array(z.string()).min(1),
  claims: z.array(extractedClaimSchema),
  evidenceValidation: evidenceValidationSchema,
  confidence: z.number().min(0).max(1),
  issuedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  analyzer: analyzerMetadataSchema,
});

export const riskAttestationSchema = z.object({
  attestationId: z.string().min(1),
  verdictId: z.string().min(1),
  riskEventId: z.string().min(1),
  policyId: z.string().min(1),
  chainId: z.number().int().positive(),
  verifyingContract: addressSchema,
  signer: addressSchema,
  verdictHash: hex32Schema,
  evidenceHash: hex32Schema,
  signature: signatureSchema,
  issuedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});

export const positionStateSchema = z.object({
  chainId: z.number().int().positive(),
  blockNumber: uintStringSchema,
  observedAt: isoTimestampSchema,
  user: addressSchema,
  collateralToken: addressSchema,
  debtToken: addressSchema,
  aToken: addressSchema,
  variableDebtToken: addressSchema,
  collateralBalanceWei: uintStringSchema,
  debtBalanceWei: uintStringSchema,
  totalCollateralBase: uintStringSchema,
  totalDebtBase: uintStringSchema,
  availableBorrowsBase: uintStringSchema,
  liquidationThresholdBps: z.number().int().min(0).max(10_000),
  ltvBps: z.number().int().min(0).max(10_000),
  healthFactorWad: uintStringSchema,
  xbEthPriceBase: uintStringSchema,
  xethPriceBase: uintStringSchema,
  singleMarketPosition: z.boolean(),
  positionScopeReason: z.string(),
  dataFresh: z.boolean(),
});

export const liquidityQuoteSchema = z.object({
  chainId: z.number().int().positive(),
  blockNumber: uintStringSchema,
  observedAt: isoTimestampSchema,
  pool: addressSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  feeTier: z.number().int().min(0).max(1_000_000),
  amountInWei: uintStringSchema,
  expectedAmountOutWei: uintStringSchema,
  oracleReferencePriceWad: uintStringSchema,
  spotPriceWad: uintStringSchema,
  executionPriceWad: uintStringSchema,
  oraclePoolDeviationBps: z.number().int().nonnegative(),
  priceImpactBps: z.number().int().nonnegative(),
  estimatedSlippageBps: z.number().int().nonnegative(),
  activeLiquidity: uintStringSchema,
  poolTokenInBalanceWei: uintStringSchema,
  poolTokenOutBalanceWei: uintStringSchema,
  quoteGasEstimate: uintStringSchema,
  estimatedExecutionGas: uintStringSchema,
  gasPriceWei: uintStringSchema,
  estimatedExecutionCostWei: uintStringSchema,
  executable: z.boolean(),
  failureReason: z.string().nullable(),
});

export const executionPlanSchema = z.object({
  repayAmountWei: uintStringSchema,
  collateralAmountWei: uintStringSchema,
  expectedSwapOutWei: uintStringSchema,
  minimumSwapOutWei: uintStringSchema,
  projectedPostHealthFactorWad: uintStringSchema,
  flashLoanPremiumCeilingWei: uintStringSchema,
  executable: z.boolean(),
  failureReason: z.string().nullable(),
});

export const marketContextSchema = z.object({
  position: positionStateSchema,
  liquidity: liquidityQuoteSchema,
  plan: executionPlanSchema,
});

export const userProtectionPolicySchema = z.object({
  policyId: z.string().min(1),
  policyVersion: z.number().int().positive(),
  user: addressSchema,
  executor: addressSchema,
  chainId: z.number().int().positive(),
  egressContract: addressSchema,
  approvedRiskAttestor: addressSchema,
  riskTrigger: materialRiskLevelSchema,
  minimumConfidence: z.number().min(0).max(1),
  triggerHealthFactorWad: uintStringSchema,
  minimumPostHealthFactorWad: uintStringSchema,
  targetPostHealthFactorWad: uintStringSchema,
  maximumRepaymentWei: uintStringSchema,
  maximumCollateralWei: uintStringSchema,
  maximumCollateralPercentageBps: z.number().int().min(1).max(10_000),
  maximumSlippageBps: z.number().int().min(0).max(10_000),
  maximumPriceImpactBps: z.number().int().min(0).max(10_000),
  maximumOraclePoolDeviationBps: z.number().int().min(0).max(10_000),
  maximumFlashLoanPremiumBps: z.number().int().min(0).max(10_000),
  cooldownSeconds: z.number().int().nonnegative(),
  authorizationExpiresAt: isoTimestampSchema,
  intentTtlSeconds: z.number().int().positive(),
  verdictMaxAgeSeconds: z.number().int().positive(),
  marketMaxAgeSeconds: z.number().int().positive(),
  maximumClockSkewSeconds: z.number().int().nonnegative(),
  automaticExecutionEnabled: z.boolean(),
  approvedSourceIds: z.array(z.string()).min(1),
});

export const policyRuntimeStateSchema = z.object({
  evaluatedAt: isoTimestampSchema,
  lastExecutionAt: isoTimestampSchema.nullable(),
  authorizationNonce: uintStringSchema,
  revocationNonce: uintStringSchema,
  nonceAlreadyUsed: z.boolean(),
  executorPaused: z.boolean(),
  userAuthorizationSignature: signatureSchema.nullable(),
  collateralAuthorizationAvailable: z.boolean(),
});

export const policyCheckSchema = z.object({
  check: z.string().min(1),
  passed: z.boolean(),
  actual: z.string(),
  required: z.string(),
  reason: z.string(),
});

export const executorAuthorizationSchema = z.object({
  user: addressSchema,
  executor: addressSchema,
  repayAmount: uintStringSchema,
  collateralAmount: uintStringSchema,
  maxRepayment: uintStringSchema,
  maxCollateral: uintStringSchema,
  expectedSwapOut: uintStringSchema,
  minSwapOut: uintStringSchema,
  maxSlippageBps: uintStringSchema,
  maxFlashLoanPremiumBps: uintStringSchema,
  minPostHealthFactor: uintStringSchema,
  deadline: uintStringSchema,
  nonce: uintStringSchema,
  revocationNonce: uintStringSchema,
});

export const executionIntentSchema = z.object({
  intentId: z.string().min(1),
  riskEventId: z.string().min(1),
  riskVerdictId: z.string().min(1),
  policyId: z.string().min(1),
  allowed: z.boolean(),
  autoExecutionEligible: z.boolean(),
  requiresUserSignature: z.boolean(),
  status: z.enum([
    "REJECTED",
    "AWAITING_USER_SIGNATURE",
    "READY_FOR_SUBMISSION",
  ]),
  reasons: z.array(z.string()),
  checks: z.array(policyCheckSchema),
  generatedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  chainId: z.number().int().positive(),
  egressContract: addressSchema,
  authorization: executorAuthorizationSchema.nullable(),
  intentHash: hex32Schema,
});

export const deleveragedExecutionSchema = z.object({
  user: addressSchema,
  executor: addressSchema,
  nonce: uintStringSchema,
  authorizationHash: hex32Schema,
  debtRepaidWei: uintStringSchema,
  collateralSoldWei: uintStringSchema,
  swapOutputWei: uintStringSchema,
  flashPremiumWei: uintStringSchema,
  surplusReturnedWei: uintStringSchema,
  healthFactorBeforeWad: uintStringSchema,
  healthFactorAfterWad: uintStringSchema,
});

export const executionResultSchema = z.object({
  status: z.enum([
    "NOT_SUBMITTED",
    "SIMULATED",
    "SUBMITTED",
    "CONFIRMED",
    "REVERTED",
    "FAILED_VALIDATION",
  ]),
  transactionHash: hex32Schema.nullable(),
  blockNumber: uintStringSchema.nullable(),
  gasUsed: uintStringSchema.nullable(),
  observedAt: isoTimestampSchema,
  message: z.string(),
  deleveraged: deleveragedExecutionSchema.nullable(),
});

export const riskEventRecordSchema = z.object({
  riskEventId: z.string().min(1),
  mode: z.enum(["LIVE", "REPLAY", "TEST"]),
  createdAt: isoTimestampSchema,
  sourceRevisionIds: z.array(z.string()),
  diffIds: z.array(z.string()),
  policy: userProtectionPolicySchema,
  policyRuntime: policyRuntimeStateSchema,
  analysis: modelRiskAnalysisSchema.nullable(),
  verdict: riskVerdictSchema,
  attestation: riskAttestationSchema.nullable(),
  marketContext: marketContextSchema.nullable(),
  intent: executionIntentSchema.nullable(),
  executionResult: executionResultSchema.nullable(),
});

export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;
export type NormalizedLine = z.infer<typeof normalizedLineSchema>;
export type NormalizedDocument = z.infer<typeof normalizedDocumentSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type SourceDiff = z.infer<typeof sourceDiffSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;
export type ModelRiskAnalysis = z.infer<typeof modelRiskAnalysisSchema>;
export type AnalyzerMetadata = z.infer<typeof analyzerMetadataSchema>;
export type EvidenceValidation = z.infer<typeof evidenceValidationSchema>;
export type RiskVerdict = z.infer<typeof riskVerdictSchema>;
export type RiskAttestation = z.infer<typeof riskAttestationSchema>;
export type PositionState = z.infer<typeof positionStateSchema>;
export type LiquidityQuote = z.infer<typeof liquidityQuoteSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type MarketContext = z.infer<typeof marketContextSchema>;
export type UserProtectionPolicy = z.infer<typeof userProtectionPolicySchema>;
export type PolicyRuntimeState = z.infer<typeof policyRuntimeStateSchema>;
export type ExecutionIntent = z.infer<typeof executionIntentSchema>;
export type DeleveragedExecution = z.infer<typeof deleveragedExecutionSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export type RiskEventRecord = z.infer<typeof riskEventRecordSchema>;
