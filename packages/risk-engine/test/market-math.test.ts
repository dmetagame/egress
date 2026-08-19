import { describe, expect, it } from "vitest";
import { maximumRepayCoveredBySwap, percentMul, percentMulUp } from "../src/market/math.js";

describe("market percentage math", () => {
  it("rounds protocol fee ceilings upward by one wei when required", () => {
    expect(percentMul(1n, 5n)).toBe(0n);
    expect(percentMulUp(1n, 5n)).toBe(1n);
  });

  it("keeps exactly divisible protocol fees unchanged", () => {
    expect(percentMulUp(1_000_000n, 5n)).toBe(500n);
  });

  it("does not select a repayment whose ceiling premium exceeds minimum output", () => {
    expect(maximumRepayCoveredBySwap(1n, 5n)).toBe(0n);
    expect(maximumRepayCoveredBySwap(2n, 5n)).toBe(1n);
  });
});
