import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const excludedDirectories = new Set([
  ".git",
  ".next",
  ".data",
  ".vercel",
  "node_modules",
  "dist",
  "out",
  "cache",
  "coverage",
  "test-results",
  "playwright-report",
]);
const ignoredNames = /(^|\/)(\.env(?:\..*)?\.local|\.env$|.*\.(?:log|pid|key|pem|secret|secrets|credentials))$/u;
const safeFixtureValue = /^(?:<[^>]+>|secret|hidden|private-value|(?:0x)?1{32,}|s{32,})$/iu;
const deterministicWalletPhrase = ["test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "test", "junk"].join(" ");
const deterministicWalletAssignment = `string memory ${["mnemo", "nic"].join("")} = "${deterministicWalletPhrase}";`;
const phase10PublicDatabaseFixture = ["NEXT", "_PUBLIC_", "EGRESS_", "DATABASE", '_URL: "postgresql://public:secret@db.example/egress"'].join("");
const phase11PublicKeyFixture = ["NEXT", "_PUBLIC_", "EXECUTION", '_PRIVATE_KEY: "forbidden"'].join("");

const files = await candidateFiles();
const findings = [];
for (const file of files) {
  let text;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 3_000_000) continue;
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const relativePath = relative(root, file).replaceAll(sep, "/");
    const location = `${relativePath}:${index + 1}`;
    const credentialUrl = line.match(/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s"')]+/u);
    if (credentialUrl && !/\.(?:example|invalid|test)$/iu.test(credentialUrl[0].split("@")[1]?.split("/")[0] ?? "")) {
      findings.push(`${location} embedded URL credentials`);
    }

    const assignment = line.match(/\b(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|WALLET_SECRET|BEARER_TOKEN|API_KEY|ACCESS_TOKEN|DATABASE_URL|WEBHOOK_SECRET)\b\s*[:=]\s*["']?([^"'\s,}]+)["']?/iu);
    if (assignment) {
      const value = assignment[2] ?? "";
      const isBlank = value.length === 0 || value === "undefined" || value === "null";
      const isPlaceholder = safeFixtureValue.test(value) || /example\.(?:com|invalid|test)|<[^>]+>/iu.test(value);
      const isFixture = /(?:^|[\\/])(?:test|fixtures)(?:[\\/]|$)/u.test(file);
      const intentionalFixture = isIntentionalFixture(relativePath, line, "assignment");
      if (!isBlank && !isPlaceholder && !intentionalFixture && !(isFixture && /secret|private|token|password/iu.test(value))) {
        findings.push(`${location} non-placeholder ${assignment[1].toUpperCase()} value`);
      }
    }

    const publicSensitive = line.match(/\bNEXT_PUBLIC_[A-Z0-9_]*(?:PRIVATE|SECRET|DATABASE|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*\b\s*[:=]\s*["']?([^"'\s,}]+)["']?/u);
    if (
      publicSensitive &&
      publicSensitive[1] &&
      !safeFixtureValue.test(publicSensitive[1]) &&
      !isIntentionalFixture(relativePath, line, "public-sensitive")
    ) {
      findings.push(`${location} server secret uses NEXT_PUBLIC_ prefix`);
    }

    if (/\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/u.test(line)) {
      findings.push(`${location} recognized credential token pattern`);
    }
  });
}

function isIntentionalFixture(relativePath, line, kind) {
  if (
    kind === "assignment" &&
    relativePath === "lib/forge-std/test/StdCheats.t.sol" &&
    line.includes(deterministicWalletAssignment)
  ) {
    return true;
  }

  if (kind === "public-sensitive") {
    return (
      (relativePath === "packages/risk-engine/test/phase10-harness.test.ts" &&
        line.includes(phase10PublicDatabaseFixture)) ||
      (relativePath === "packages/risk-engine/test/phase11-harness.test.ts" &&
        line.includes(phase11PublicKeyFixture))
    );
  }

  return false;
}

if (findings.length > 0) {
  console.error("Public secret scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Public secret scan passed (${files.length} publication candidates checked).`);
}

async function candidateFiles() {
  let tracked = [];
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((file) => join(root, file));
  } catch {
    tracked = [];
  }
  if (tracked.length > 0) return tracked.filter((file) => !ignoredNames.test(relative(root, file).replaceAll(sep, "/")));

  const result = [];
  await walk(root, result);
  return result;
}

async function walk(directory, result) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (ignoredNames.test(relative(root, path).replaceAll(sep, "/"))) continue;
    if (entry.isDirectory()) await walk(path, result);
    else result.push(path);
  }
}
