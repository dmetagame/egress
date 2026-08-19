import {
  verifyTypedData,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import type {
  RiskAttestation,
  RiskVerdict,
  UserProtectionPolicy,
} from "../domain/schemas.js";
import { objectHash, shortId } from "../domain/hash.js";

export const RISK_ATTESTATION_TYPES = {
  RiskAttestation: [
    { name: "verdictHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "policyIdHash", type: "bytes32" },
    { name: "riskEventIdHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

function timestampSeconds(value: string): bigint {
  return BigInt(Math.floor(new Date(value).getTime() / 1_000));
}

export function riskAttestationPayload(
  verdict: RiskVerdict,
  policy: UserProtectionPolicy,
) {
  const evidence = verdict.claims.flatMap((claim) => claim.evidence);
  return {
    verdictHash: objectHash(verdict),
    evidenceHash: objectHash(evidence),
    policyIdHash: objectHash(policy.policyId),
    riskEventIdHash: objectHash(verdict.riskEventId),
    issuedAt: timestampSeconds(verdict.issuedAt),
    expiresAt: timestampSeconds(verdict.expiresAt),
  } as const;
}

export function riskAttestationDomain(policy: UserProtectionPolicy) {
  return {
    name: "Egress Risk Attestor",
    version: "1",
    chainId: policy.chainId,
    verifyingContract: policy.egressContract as Address,
  } as const;
}

export class RiskAttestationSigner {
  constructor(private readonly account: PrivateKeyAccount) {}

  async sign(
    verdict: RiskVerdict,
    policy: UserProtectionPolicy,
  ): Promise<RiskAttestation> {
    if (this.account.address.toLowerCase() !== policy.approvedRiskAttestor.toLowerCase()) {
      throw new Error("Configured signer is not the policy-approved risk attestor");
    }
    const payload = riskAttestationPayload(verdict, policy);
    const signature = await this.account.signTypedData({
      domain: riskAttestationDomain(policy),
      types: RISK_ATTESTATION_TYPES,
      primaryType: "RiskAttestation",
      message: payload,
    });
    const base = {
      verdictId: verdict.verdictId,
      policyId: policy.policyId,
      signer: this.account.address,
      signature,
    };
    return {
      attestationId: shortId("attestation", base),
      verdictId: verdict.verdictId,
      riskEventId: verdict.riskEventId,
      policyId: policy.policyId,
      chainId: policy.chainId,
      verifyingContract: policy.egressContract,
      signer: this.account.address,
      verdictHash: payload.verdictHash,
      evidenceHash: payload.evidenceHash,
      signature,
      issuedAt: verdict.issuedAt,
      expiresAt: verdict.expiresAt,
    };
  }
}

export async function verifyRiskAttestation(input: {
  attestation: RiskAttestation;
  verdict: RiskVerdict;
  policy: UserProtectionPolicy;
}): Promise<{ valid: boolean; reason: string }> {
  const { attestation, verdict, policy } = input;
  const payload = riskAttestationPayload(verdict, policy);
  if (
    attestation.verdictId !== verdict.verdictId ||
    attestation.riskEventId !== verdict.riskEventId ||
    attestation.policyId !== policy.policyId ||
    attestation.chainId !== policy.chainId ||
    attestation.verifyingContract.toLowerCase() !== policy.egressContract.toLowerCase() ||
    attestation.signer.toLowerCase() !== policy.approvedRiskAttestor.toLowerCase() ||
    attestation.verdictHash !== payload.verdictHash ||
    attestation.evidenceHash !== payload.evidenceHash ||
    attestation.issuedAt !== verdict.issuedAt ||
    attestation.expiresAt !== verdict.expiresAt
  ) {
    return { valid: false, reason: "Attestation fields do not match the verdict and policy." };
  }

  let valid = false;
  try {
    valid = await verifyTypedData({
      address: policy.approvedRiskAttestor as Address,
      domain: riskAttestationDomain(policy),
      types: RISK_ATTESTATION_TYPES,
      primaryType: "RiskAttestation",
      message: payload,
      signature: attestation.signature as Hex,
    });
  } catch {
    valid = false;
  }
  return {
    valid,
    reason: valid ? "Risk attestation signature is valid." : "Risk attestation signature is invalid.",
  };
}
