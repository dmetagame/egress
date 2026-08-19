import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { validatePhase11EvmIdentities } from "../src/index.js";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;

const distinctIdentities = () => ({
  deployer: address(101),
  keeper: address(102),
  borrower: address(103),
  riskAttestor: address(104),
});

describe("Phase 11 EVM identity isolation", () => {
  it("accepts four present, valid, pairwise-distinct identities", () => {
    expect(validatePhase11EvmIdentities(distinctIdentities())).toEqual({
      deployer: getAddress(address(101)),
      keeper: getAddress(address(102)),
      borrower: getAddress(address(103)),
      riskAttestor: getAddress(address(104)),
    });
  });

  it.each([
    ["deployer", "keeper"],
    ["deployer", "borrower"],
    ["deployer", "riskAttestor"],
    ["keeper", "borrower"],
    ["keeper", "riskAttestor"],
    ["borrower", "riskAttestor"],
  ] as const)("rejects %s == %s", (left, right) => {
    const identities = distinctIdentities();
    identities[right] = identities[left];
    const leftLabel = identityLabel(left);
    const rightLabel = identityLabel(right);
    expect(() => validatePhase11EvmIdentities(identities)).toThrow(
      new RegExp(`${leftLabel} and ${rightLabel} identities must be distinct`, "i"),
    );
  });

  it("normalizes checksum and casing before comparing identities", () => {
    const lowerCase = "0x52908400098527886e0f7030069857d2e4169ee7";
    expect(() => validatePhase11EvmIdentities({
      ...distinctIdentities(),
      deployer: lowerCase,
      keeper: getAddress(lowerCase),
    })).toThrow(/deployer and keeper identities must be distinct/i);
  });

  it("rejects a missing identity", () => {
    expect(() => validatePhase11EvmIdentities({
      ...distinctIdentities(),
      borrower: undefined,
    })).toThrow(/borrower address is required/i);
  });

  it("rejects a malformed identity without echoing credential material", () => {
    expect(() => validatePhase11EvmIdentities({
      ...distinctIdentities(),
      riskAttestor: "not-an-address",
    })).toThrow(/risk attestor address is not a valid EVM address/i);
  });
});

function identityLabel(value: string): string {
  return value === "riskAttestor" ? "risk attestor" : value;
}
