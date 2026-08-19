import { describe, expect, it } from "vitest";
import {
  assertPhase10ForkHarnessConfig,
  PHASE10_LOCAL_ANVIL_RPC,
  readPhase10ForkHarnessConfig,
} from "../src/index.js";

describe("Phase 10 pinned-fork harness configuration", () => {
  it("accepts only an explicit fork opt-in with separately credentialed PostgreSQL roles", () => {
    const config = readPhase10ForkHarnessConfig(validEnvironment());
    expect(config.issues).toEqual([]);
    expect(config.localRpcUrl).toBe(PHASE10_LOCAL_ANVIL_RPC);
    expect(() => assertPhase10ForkHarnessConfig(config)).not.toThrow();
  });

  it("fails closed when the upstream RPC or either database role is absent", () => {
    const config = readPhase10ForkHarnessConfig({
      EGRESS_EXECUTION_ENVIRONMENT: "FORK_WRITE",
      EGRESS_EXECUTION_SUBMISSION_ENABLED: "true",
    });
    expect(config.issues).toContain("EGRESS_XLAYER_FORK_RPC_URL is required for the pinned X Layer fork.");
    expect(config.issues).toContain("EGRESS_PHASE10_ARCHIVE_DATABASE_URL is required for the Phase 10 PostgreSQL path.");
    expect(config.issues).toContain("EGRESS_DATABASE_URL is required for the Phase 10 PostgreSQL path.");
    expect(() => assertPhase10ForkHarnessConfig(config)).toThrow(/required|incomplete/i);
  });

  it("rejects local or insecure upstream RPCs and ambiguous database credentials", () => {
    const insecure = readPhase10ForkHarnessConfig({
      ...validEnvironment(),
      EGRESS_XLAYER_FORK_RPC_URL: "http://127.0.0.1:9545",
      EGRESS_DATABASE_URL: "postgresql://archive:secret@db.example/egress",
    });
    expect(insecure.issues).toContain(
      "EGRESS_XLAYER_FORK_RPC_URL must be a non-local HTTPS X Layer RPC endpoint.",
    );
    expect(insecure.issues).toContain(
      "Phase 10 archive and execution worker PostgreSQL credentials must use distinct roles.",
    );
  });

  it("rejects live-mainnet flags, private keys, and client-visible server configuration", () => {
    const config = readPhase10ForkHarnessConfig({
      ...validEnvironment(),
      EGRESS_LIVE_MAINNET_BROADCAST: "true",
      EGRESS_EXECUTION_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      NEXT_PUBLIC_EGRESS_DATABASE_URL: "postgresql://public:secret@db.example/egress",
    });
    expect(config.issues).toContain("LIVE mainnet execution and broadcasting must remain disabled.");
    expect(config.issues).toContain(
      "The pinned Phase 10 fork uses the deterministic local Anvil keeper and must not receive a private key.",
    );
    expect(config.issues).toContain(
      "NEXT_PUBLIC_EGRESS_DATABASE_URL is server-only and must not use the NEXT_PUBLIC_ prefix.",
    );
  });

  it("rejects any environment other than the pinned local FORK_WRITE target", () => {
    const config = readPhase10ForkHarnessConfig({
      ...validEnvironment(),
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_RPC_URL: "https://testrpc.example",
      EGRESS_EXECUTION_CHAIN_ID: "1952",
      EGRESS_EXECUTION_FORK_RUNTIME: "OTHER",
    });
    expect(config.issues).toContain("Phase 10 requires EGRESS_EXECUTION_ENVIRONMENT=FORK_WRITE.");
    expect(config.issues).toContain(`Phase 10 FORK_WRITE must target ${PHASE10_LOCAL_ANVIL_RPC}.`);
    expect(config.issues).toContain("Phase 10 FORK_WRITE must use X Layer chain 196.");
    expect(config.issues).toContain("Phase 10 FORK_WRITE requires EGRESS_EXECUTION_FORK_RUNTIME=ANVIL.");
  });
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    EGRESS_EXECUTION_ENVIRONMENT: "FORK_WRITE",
    EGRESS_EXECUTION_SUBMISSION_ENABLED: "true",
    EGRESS_XLAYER_FORK_RPC_URL: "https://rpc.example/xlayer",
    EGRESS_PHASE10_ARCHIVE_DATABASE_URL: "postgresql://archive:secret@db.example/egress",
    EGRESS_DATABASE_URL: "postgresql://worker:secret@db.example/egress",
    EGRESS_EXECUTION_RPC_URL: PHASE10_LOCAL_ANVIL_RPC,
    EGRESS_EXECUTION_CHAIN_ID: "196",
    EGRESS_EXECUTION_FORK_RUNTIME: "ANVIL",
  };
}
