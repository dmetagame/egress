import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, isPublicReadOnlyRuntime } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("protection typed-data route", () => {
  it("recognizes hosted and production runtimes as public read-only", () => {
    expect(isPublicReadOnlyRuntime({ NODE_ENV: "production" })).toBe(true);
    expect(isPublicReadOnlyRuntime({ VERCEL: "1" })).toBe(true);
    expect(isPublicReadOnlyRuntime({ EGRESS_DEPLOYMENT_ENV: "production" })).toBe(true);
    expect(isPublicReadOnlyRuntime({ NODE_ENV: "development" })).toBe(false);
  });

  it("refuses policy preparation before loading fork evidence in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await GET(new Request("http://localhost/api/protection/typed-data?user=0x1111111111111111111111111111111111111111"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Policy preparation is disabled in the public read-only demo.",
    });
  });
});
