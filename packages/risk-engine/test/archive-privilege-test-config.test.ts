import { describe, expect, it } from "vitest";
import {
  ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT,
  archivePrivilegeTestRequested,
  resolveArchivePrivilegeTestConfig,
} from "./archive-privilege-test-config.js";

const TEST_URL = "postgresql://egress_archive_test:secret@db.example/egress_phase11_test";

describe("archive privilege integration-test isolation", () => {
  it("does not request a database connection without explicit variables", () => {
    expect(archivePrivilegeTestRequested({})).toBe(false);
    expect(resolveArchivePrivilegeTestConfig({})).toBeNull();
  });

  it("fails closed when the URL or acknowledgement is missing", () => {
    expect(() => resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL: TEST_URL,
    })).toThrow(/both dedicated test database variables/i);
    expect(() => resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE: ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT,
    })).toThrow(/both dedicated test database variables/i);
  });

  it("requires the exact acknowledgement marker", () => {
    expect(() => resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL: TEST_URL,
      EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE: "yes",
    })).toThrow(/acknowledgement is invalid/i);
  });

  it("rejects production-like or ambiguously named targets", () => {
    expect(() => resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL:
        "postgresql://archive:secret@prod-db.example/egress_phase11_test",
      EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE: ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT,
    })).toThrow(/production-like/i);
    expect(() => resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL:
        "postgresql://archive:secret@db.example/egress",
      EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE: ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT,
    })).toThrow(/explicitly identify a test scope/i);
  });

  it("rejects reuse of a configured runtime credential", () => {
    expect(() => resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL: TEST_URL,
      EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE: ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT,
      EGRESS_PHASE11_ARCHIVE_DATABASE_URL: TEST_URL,
    })).toThrow(/must not reuse a configured runtime database credential/i);
  });

  it("accepts a dedicated, explicitly acknowledged test database", () => {
    expect(resolveArchivePrivilegeTestConfig({
      EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL: TEST_URL,
      EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE: ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT,
    })).toEqual({
      databaseUrl: TEST_URL,
      databaseName: "egress_phase11_test",
    });
  });
});
