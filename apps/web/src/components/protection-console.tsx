"use client";

import { useState } from "react";
import {
  Check,
  Eraser,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  ShieldOff,
  Wallet,
  X,
} from "lucide-react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  parseSignature,
  type Address,
  type Hex,
} from "viem";
import type { ProductSnapshot, TypedPolicyResponse } from "@/lib/types";
import { bps, duration, healthFactor, shortHash, tokenAmount, unixDate } from "@/lib/format";
import { AddressText, DefinitionRow, SectionHeading, StatusPill } from "./primitives";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const policyTypes = {
  ProtectionPolicy: [
    { name: "user", type: "address" },
    { name: "keeper", type: "address" },
    { name: "riskAttestor", type: "address" },
    { name: "protocolConfigHash", type: "bytes32" },
    { name: "minimumRiskLevel", type: "uint8" },
    { name: "maxRepaymentPerExecution", type: "uint256" },
    { name: "maxCollateralPerExecution", type: "uint256" },
    { name: "maxCumulativeRepayment", type: "uint256" },
    { name: "maxCumulativeCollateral", type: "uint256" },
    { name: "maxCollateralPercentageBps", type: "uint256" },
    { name: "maxPositionDebt", type: "uint256" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "maxOracleDeviationBps", type: "uint256" },
    { name: "maxFlashLoanPremiumBps", type: "uint256" },
    { name: "maxPreHealthFactor", type: "uint256" },
    { name: "minPostHealthFactor", type: "uint256" },
    { name: "cooldownSeconds", type: "uint256" },
    { name: "maxExecutions", type: "uint256" },
    { name: "maxRiskAgeSeconds", type: "uint256" },
    { name: "maxClockSkewSeconds", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "revocationNonce", type: "uint256" },
  ],
} as const;

const revokeAbi = [
  {
    type: "function",
    name: "revokeProtectionPolicy",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
] as const;

const signatureComponents = [
  { name: "v", type: "uint8" },
  { name: "r", type: "bytes32" },
  { name: "s", type: "bytes32" },
] as const;

const registrationAbi = [
  {
    type: "function",
    name: "registerProtectionPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "policy", type: "tuple", components: policyTypes.ProtectionPolicy },
      { name: "policySignature", type: "tuple", components: signatureComponents },
      {
        name: "collateralPermit",
        type: "tuple",
        components: [{ name: "deadline", type: "uint256" }, ...signatureComponents],
      },
    ],
    outputs: [{ name: "policyId", type: "bytes32" }],
  },
] as const;

const runtimeAbi = [
  {
    type: "function",
    name: "PROTOCOL_CONFIG_HASH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "value", type: "bytes32" }],
  },
] as const;

const PUBLIC_DEMO_READ_ONLY = process.env.NODE_ENV === "production";
const FORK_WRITES_ENABLED = !PUBLIC_DEMO_READ_ONLY && process.env.NEXT_PUBLIC_EGRESS_ENABLE_FORK_WRITES === "true";
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

async function verifyForkRuntime(snapshot: ProductSnapshot) {
  if (!FORK_WRITES_ENABLED) {
    throw new Error("Fork writes are disabled in this build; no wallet transaction can be submitted");
  }
  const client = createPublicClient({ transport: custom(provider()) });
  const chainId = await client.getChainId();
  if (chainId !== snapshot.environment.chainId) {
    throw new Error(`Wallet is on chain ${chainId}; switch to the pinned fork chain ${snapshot.environment.chainId}`);
  }
  const executor = snapshot.contracts.egressExecutor as Address;
  const bytecode = await client.getBytecode({ address: executor });
  if (!bytecode || bytecode === "0x") {
    throw new Error("Pinned fork executor is unavailable; no write was submitted");
  }
  const protocolConfigHash = await client.readContract({
    address: executor,
    abi: runtimeAbi,
    functionName: "PROTOCOL_CONFIG_HASH",
  });
  if (protocolConfigHash.toLowerCase() !== snapshot.authorization.policy.protocolConfigHash.toLowerCase()) {
    throw new Error("Connected runtime does not match the pinned Egress protocol configuration");
  }
}

function provider(): Eip1193Provider {
  if (!window.ethereum) throw new Error("No browser wallet detected");
  return window.ethereum;
}

function messageFromPolicy(policy: TypedPolicyResponse["policy"]) {
  return {
    user: policy.user as Address,
    keeper: policy.keeper as Address,
    riskAttestor: policy.riskAttestor as Address,
    protocolConfigHash: policy.protocolConfigHash as Hex,
    minimumRiskLevel: policy.minimumRiskLevel,
    maxRepaymentPerExecution: BigInt(policy.maxRepaymentPerExecution),
    maxCollateralPerExecution: BigInt(policy.maxCollateralPerExecution),
    maxCumulativeRepayment: BigInt(policy.maxCumulativeRepayment),
    maxCumulativeCollateral: BigInt(policy.maxCumulativeCollateral),
    maxCollateralPercentageBps: BigInt(policy.maxCollateralPercentageBps),
    maxPositionDebt: BigInt(policy.maxPositionDebt),
    maxSlippageBps: BigInt(policy.maxSlippageBps),
    maxOracleDeviationBps: BigInt(policy.maxOracleDeviationBps),
    maxFlashLoanPremiumBps: BigInt(policy.maxFlashLoanPremiumBps),
    maxPreHealthFactor: BigInt(policy.maxPreHealthFactor),
    minPostHealthFactor: BigInt(policy.minPostHealthFactor),
    cooldownSeconds: BigInt(policy.cooldownSeconds),
    maxExecutions: BigInt(policy.maxExecutions),
    maxRiskAgeSeconds: BigInt(policy.maxRiskAgeSeconds),
    maxClockSkewSeconds: BigInt(policy.maxClockSkewSeconds),
    expiresAt: BigInt(policy.expiresAt),
    nonce: BigInt(policy.nonce),
    revocationNonce: BigInt(policy.revocationNonce),
  } as const;
}

function contractSignature(signature: Hex) {
  const parsed = parseSignature(signature);
  const recovery = parsed.v ?? BigInt(parsed.yParity + 27);
  return { v: Number(recovery < 27n ? recovery + 27n : recovery), r: parsed.r, s: parsed.s } as const;
}

export function PolicyReview({ snapshot }: { snapshot: ProductSnapshot }) {
  const policy = snapshot.authorization.policy;
  const observedAt = snapshot.market?.position?.observedAt
    ? Math.floor(new Date(snapshot.market.position.observedAt).getTime() / 1_000)
    : Number(policy.expiresAt) - 1;
  const expired = Number(policy.expiresAt) <= observedAt;
  const active = snapshot.policyState.active && !expired;
  return (
    <section className="policy-review">
      <SectionHeading
        eyebrow="User-defined protection"
        title="Protection policy"
        description="The signed policy is the authority. AI, keeper, and backend processes cannot increase these limits."
        action={
          <StatusPill tone={active ? "success" : "danger"} icon={active ? KeyRound : ShieldOff}>
            {active ? "EIP-712" : expired ? "EXPIRED" : "REVOKED"}
          </StatusPill>
        }
      />
      <div className="policy-review-grid">
        <dl className="definition-list">
          <DefinitionRow label="Risk trigger">{policy.minimumRiskLevel === 3 ? "HIGH" : "CRITICAL"}</DefinitionRow>
          <DefinitionRow label="Trigger health factor">{"HF <= "}{healthFactor(policy.maxPreHealthFactor)}</DefinitionRow>
          <DefinitionRow label="Minimum post-action HF">{healthFactor(policy.minPostHealthFactor)}</DefinitionRow>
          <DefinitionRow label="Maximum repayment">{tokenAmount(policy.maxRepaymentPerExecution)} xETH</DefinitionRow>
          <DefinitionRow label="Maximum collateral">{tokenAmount(policy.maxCollateralPerExecution)} xBETH</DefinitionRow>
        </dl>
        <dl className="definition-list">
          <DefinitionRow label="Collateral percentage">{bps(policy.maxCollateralPercentageBps)}</DefinitionRow>
          <DefinitionRow label="Maximum slippage">{bps(policy.maxSlippageBps)}</DefinitionRow>
          <DefinitionRow label="Cooldown">{duration(policy.cooldownSeconds)}</DefinitionRow>
          <DefinitionRow label="Executions">{policy.maxExecutions} maximum</DefinitionRow>
          <DefinitionRow label="Expires">{unixDate(policy.expiresAt)}</DefinitionRow>
        </dl>
      </div>
      <div className="authorization-scope">
        <div>
          <span>Protected position</span>
          <AddressText value={snapshot.actors.user} />
        </div>
        <div>
          <span>Keeper</span>
          <AddressText value={snapshot.actors.keeper} />
        </div>
        <div>
          <span>Approved pool</span>
          <AddressText value={snapshot.contracts.swapPool} />
        </div>
      </div>
    </section>
  );
}

export function ProtectionSetup({ snapshot }: { snapshot: ProductSnapshot }) {
  const [address, setAddress] = useState<string | null>(null);
  const [typed, setTyped] = useState<TypedPolicyResponse | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [approvalHash, setApprovalHash] = useState<Hex | null>(null);
  const [registrationHash, setRegistrationHash] = useState<Hex | null>(null);
  const [forkReady, setForkReady] = useState(false);
  const [busy, setBusy] = useState<"connect" | "sign" | "approve" | "register" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function connect() {
    setBusy("connect");
    setMessage(null);
    try {
      const client = createWalletClient({ transport: custom(provider()) });
      const [account] = await client.requestAddresses();
      setAddress(account);
      setSignature(null);
      setApprovalHash(null);
      setRegistrationHash(null);
      if (PUBLIC_DEMO_READ_ONLY) {
        setTyped(null);
        setForkReady(false);
        setMessage("Public demo mode is read-only. Wallet connection is available for identity context; no signature or transaction is requested.");
        return;
      }
      const response = await fetch(`/api/protection/typed-data?user=${account}`);
      const data = (await response.json()) as TypedPolicyResponse | { error: string };
      if (!response.ok || "error" in data) throw new Error("error" in data ? data.error : "Policy preparation failed");
      setTyped(data);
      if (FORK_WRITES_ENABLED) {
        try {
          await verifyForkRuntime(snapshot);
          setForkReady(true);
          setMessage("Wallet connected. The pinned fork runtime is verified; review the policy before signing.");
        } catch (error) {
          setForkReady(false);
          setMessage(`Wallet connected. ${error instanceof Error ? error.message : "Fork runtime unavailable"}.`);
        }
      } else {
        setForkReady(false);
        setMessage("Wallet connected. Review the policy before signing. Registration writes are disabled in this build.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Wallet connection failed");
    } finally {
      setBusy(null);
    }
  }

  async function signPolicy() {
    if (!typed || !address) return;
    setBusy("sign");
    setMessage(null);
    try {
      const client = createWalletClient({ transport: custom(provider()) });
      const signed = await client.signTypedData({
        account: getAddress(address),
        domain: typed.domain,
        types: policyTypes,
        primaryType: "ProtectionPolicy",
        message: messageFromPolicy(typed.policy),
      });
      setSignature(signed);
      setMessage("Policy signature captured locally. A verified fork can now approve the bounded aXbETH budget and register protection.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy signing failed");
    } finally {
      setBusy(null);
    }
  }

  async function approveCollateral() {
    if (!typed || !address || !signature || !forkReady) return;
    setBusy("approve");
    setMessage(null);
    try {
      await verifyForkRuntime(snapshot);
      const wallet = createWalletClient({ transport: custom(provider()) });
      const publicClient = createPublicClient({ transport: custom(provider()) });
      const hash = await wallet.writeContract({
        account: getAddress(address),
        chain: null,
        address: snapshot.contracts.aXbEth as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [snapshot.contracts.egressExecutor as Address, BigInt(typed.policy.maxCumulativeCollateral)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setApprovalHash(hash);
      setMessage(`Bounded setup allowance confirmed on the pinned fork: ${hash}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bounded allowance transaction failed");
    } finally {
      setBusy(null);
    }
  }

  async function registerProtection() {
    if (!typed || !address || !signature || !approvalHash || !forkReady) return;
    setBusy("register");
    setMessage(null);
    try {
      await verifyForkRuntime(snapshot);
      const account = getAddress(address);
      const executor = snapshot.contracts.egressExecutor as Address;
      const publicClient = createPublicClient({ transport: custom(provider()) });
      const allowance = await publicClient.readContract({
        address: snapshot.contracts.aXbEth as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, executor],
      });
      if (allowance < BigInt(typed.policy.maxCumulativeCollateral)) {
        throw new Error("Confirmed aXbETH allowance is below the signed policy budget");
      }
      const wallet = createWalletClient({ transport: custom(provider()) });
      const hash = await wallet.writeContract({
        account,
        chain: null,
        address: executor,
        abi: registrationAbi,
        functionName: "registerProtectionPolicy",
        args: [
          messageFromPolicy(typed.policy),
          contractSignature(signature as Hex),
          { deadline: BigInt(typed.policy.expiresAt), v: 27, r: ZERO_BYTES32, s: ZERO_BYTES32 },
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setRegistrationHash(hash);
      setMessage(`Protection active on the pinned fork: ${hash}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Protection registration failed safely");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="setup-panel">
      <SectionHeading
        eyebrow="Setup / one-time authorization"
        title="Create protection"
        description="Connect a wallet, review the exact policy scope, and sign one EIP-712 policy. Autonomous execution does not request a later signature."
        action={<StatusPill tone="info" icon={Wallet}>{PUBLIC_DEMO_READ_ONLY ? "READ-ONLY DEMO" : "FORK ONLY"}</StatusPill>}
      />
      <div className="setup-steps">
        <SetupStep number="01" title="Connect wallet" complete={Boolean(address)}>
          {address ? <AddressText value={address} /> : <span>Required for policy signing</span>}
        </SetupStep>
        <SetupStep number="02" title="Review bounds" complete={Boolean(typed)}>
          {typed ? <code>{shortHash(typed.policyId)}</code> : <span>{PUBLIC_DEMO_READ_ONLY ? "Disabled in public demo" : "Generated for this wallet"}</span>}
        </SetupStep>
        <SetupStep number="03" title="Sign policy" complete={Boolean(signature)}>
          {signature ? <code>{shortHash(signature)}</code> : <span>Wallet signature, no transaction yet</span>}
        </SetupStep>
        <SetupStep number="04" title="Approve + register" complete={Boolean(registrationHash)}>
          {registrationHash
            ? <code>{shortHash(registrationHash)}</code>
            : approvalHash
              ? <span>Bounded allowance confirmed; registration pending</span>
              : <span>{forkReady ? "Ready on verified fork" : "Requires an explicitly enabled fork runtime"}</span>}
        </SetupStep>
      </div>
      <div className="setup-actions">
        <button className="button button-secondary" disabled={busy !== null} onClick={() => void connect()} type="button">
          {busy === "connect" ? <LoaderCircle className="spin" size={16} /> : <Wallet size={16} />}
          {address ? "Reconnect wallet" : "Connect wallet"}
        </button>
        <button className="button button-primary" disabled={PUBLIC_DEMO_READ_ONLY || !typed || busy !== null} onClick={() => void signPolicy()} type="button">
          {busy === "sign" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
          Sign protection policy
        </button>
        <button className="button button-secondary" disabled={!signature || !forkReady || busy !== null} onClick={() => void approveCollateral()} type="button">
          {busy === "approve" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          Approve bounded allowance
        </button>
        <button className="button button-primary" disabled={!approvalHash || !forkReady || busy !== null} onClick={() => void registerProtection()} type="button">
          {busy === "register" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
          Register protection
        </button>
      </div>
      {message ? <p className="action-message" role="status">{message}</p> : null}
      <div className="setup-disclosure">
        <ShieldOff aria-hidden="true" size={17} />
        <p>
          This screen never broadcasts to mainnet. Policy signing is available for review; registration and allowance writes require a separately enabled local fork runtime. No user funds are held by Egress.
        </p>
      </div>
    </section>
  );
}

function SetupStep({
  number,
  title,
  complete,
  children,
}: {
  number: string;
  title: string;
  complete: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={complete ? "setup-step is-complete" : "setup-step"}>
      <span className="setup-step-number">{complete ? <Check size={14} /> : number}</span>
      <div>
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function RevocationPanel({ snapshot }: { snapshot: ProductSnapshot }) {
  const [address, setAddress] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"policy" | "allowance" | null>(null);
  const [busy, setBusy] = useState<"connect" | "policy" | "allowance" | null>(null);
  const [forkReady, setForkReady] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function connect() {
    setBusy("connect");
    try {
      const client = createWalletClient({ transport: custom(provider()) });
      const [account] = await client.requestAddresses();
      const connected = getAddress(account);
      setAddress(connected);
      if (connected.toLowerCase() !== snapshot.actors.user.toLowerCase()) {
        setForkReady(false);
        setResult("Connected wallet is not the protected account; revocation and allowance actions remain disabled.");
        return;
      }
      try {
        await verifyForkRuntime(snapshot);
        setForkReady(true);
        setResult(`Connected ${connected}. Pinned fork runtime verified.`);
      } catch (error) {
        setForkReady(false);
        setResult(error instanceof Error ? error.message : "Pinned fork runtime unavailable; no write was submitted");
      }
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Wallet connection failed");
    } finally {
      setBusy(null);
    }
  }

  async function submit(action: "policy" | "allowance") {
    if (!address || !forkReady) return;
    setBusy(action);
    setResult(null);
    try {
      await verifyForkRuntime(snapshot);
      if (address.toLowerCase() !== snapshot.actors.user.toLowerCase()) {
        throw new Error("Connected wallet is not the protected account");
      }
      const client = createWalletClient({ transport: custom(provider()) });
      const account = getAddress(address);
      const hash = action === "policy"
        ? await client.writeContract({
            account,
            chain: null,
            address: snapshot.contracts.egressExecutor as Address,
            abi: revokeAbi,
            functionName: "revokeProtectionPolicy",
            args: [snapshot.authorization.policyId as Hex],
          })
        : await client.writeContract({
            account,
            chain: null,
            address: snapshot.contracts.aXbEth as Address,
            abi: erc20Abi,
            functionName: "approve",
            args: [snapshot.contracts.egressExecutor as Address, 0n],
          });
      setConfirming(null);
      setResult(`${action === "policy" ? "Policy revocation" : "Allowance cleanup"} submitted: ${hash}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Transaction rejected");
    } finally {
      setBusy(null);
    }
  }

  const canWrite = Boolean(address && forkReady && busy === null);

  return (
    <section className="revocation-panel">
      <SectionHeading
        eyebrow="User control"
        title="Revocation and allowance"
        description="Policy revocation is onchain. It does not automatically erase the existing aXbETH allowance."
        action={<StatusPill tone="warning" icon={ShieldOff}>VISIBLE CONTROL</StatusPill>}
      />
      <div className="revocation-warning">
        <ShieldOff aria-hidden="true" size={19} />
        <div>
          <strong>Two separate controls</strong>
          <p>Revoke the policy to stop autonomous execution. Set the aXbETH allowance to zero separately if you also want to remove the setup-time spending approval. The default build keeps both writes locked unless a matching local fork is explicitly enabled.</p>
        </div>
      </div>
      <div className="revocation-actions">
        <button className="button button-danger" disabled={!canWrite} onClick={() => setConfirming("policy")} type="button">
          <ShieldOff size={16} /> Revoke protection
        </button>
        <button className="button button-secondary" disabled={!canWrite} onClick={() => setConfirming("allowance")} type="button">
          <Eraser size={16} /> Set allowance to zero
        </button>
        <button className="button button-quiet" disabled={busy !== null} onClick={() => void connect()} type="button">
          {busy === "connect" ? <LoaderCircle className="spin" size={16} /> : <Wallet size={16} />}
          {address ? "Reconnect" : "Connect wallet"}
        </button>
      </div>
      {confirming ? (
        <div className="confirm-panel" data-lenis-prevent role="alertdialog" aria-label="Confirm protection action">
          <div>
            <strong>{confirming === "policy" ? "Revoke this protection policy?" : "Remove the aXbETH allowance?"}</strong>
            <p>
              {confirming === "policy"
                ? "The keeper will no longer pass the contract policy gate. Existing allowance remains visible until you clean it up separately."
                : "This sends approve(EgressExecutor, 0) to the aXbETH token. It does not revoke the policy by itself."}
            </p>
          </div>
          <div className="confirm-actions">
            <button className="icon-button" title="Cancel" onClick={() => setConfirming(null)} type="button"><X size={17} /></button>
            <button className="button button-danger" disabled={busy !== null} onClick={() => void submit(confirming)} type="button">
              {busy === confirming ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              Confirm
            </button>
          </div>
        </div>
      ) : null}
      {result ? <p className="action-message" role="status">{result}</p> : null}
      <div className="panel-meta-row">
        <span>Policy {shortHash(snapshot.authorization.policyId)}</span>
        <span>Allowance observed after setup: {tokenAmount(snapshot.policyState.collateralAllowance)} xBETH</span>
        <span>Fork writes: {forkReady ? "verified" : "locked"}</span>
        <a href="https://docs.xlayer.tech/" target="_blank" rel="noreferrer">X Layer docs <ExternalLink size={13} /></a>
      </div>
    </section>
  );
}
