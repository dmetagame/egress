import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const paths = {
  journal: resolve(root, "deployments/phase11/xlayer-testnet.json.journal.json"),
  reconciliation: resolve(root, "deployments/phase11/xlayer-testnet.json.journal.json.reconciliation.json"),
  manifest: resolve(root, "deployments/phase11/xlayer-testnet.json"),
};
const expected = {
  journal: "f1b7dc9a4d4b03f05a0850cd67f23166ceb3b616b5cf574b49ff6b749000fa8a",
  reconciliation: "113036b609e8847b546a9d5936c844cfa687645730f3d19cd0d1f3937d4a8bdb",
  manifest: "2d14c91dc10ca7a5cd1356e822151d6c44b95f0d673ece251db6e52056804eac",
};

const contents = {};
for (const [name, path] of Object.entries(paths)) {
  const raw = await readFile(path);
  const hash = createHash("sha256").update(raw).digest("hex");
  if (hash !== expected[name]) throw new Error(`${name} SHA-256 does not match the release evidence value.`);
  contents[name] = JSON.parse(raw.toString("utf8"));
}

const { journal, reconciliation, manifest } = contents;
if (journal.schemaVersion !== 2 || journal.status !== "COMPLETE" || journal.expectedTransactionCount !== 26) {
  throw new Error("Legacy Phase 11 journal is not the expected complete v2 record.");
}
if (
  reconciliation.schemaVersion !== 1 ||
  reconciliation.overallStatus !== "PASS" ||
  reconciliation.chainId !== 1952 ||
  reconciliation.transactions?.length !== 26
) {
  throw new Error("Phase 11 reconciliation artifact is not the expected PASS record.");
}
if (
  manifest.schemaVersion !== 4 ||
  manifest.chainId !== 1952 ||
  manifest.expectedTransactionCount !== 26 ||
  manifest.finalityPolicy?.publication !== "FINALIZED" ||
  manifest.runtimeVerification?.status !== "PASS" ||
  manifest.deploymentTransactions?.length !== 26
) {
  throw new Error("Phase 11 manifest does not satisfy the finalized publication contract.");
}

const transactions = [...manifest.deploymentTransactions].sort((left, right) => left.sequence - right.sequence);
const hashes = new Set(transactions.map((transaction) => transaction.transactionHash.toLowerCase()));
const nonces = transactions.map((transaction) => BigInt(transaction.nonce));
if (hashes.size !== 26 || nonces.some((nonce, index) => nonce !== BigInt(index))) {
  throw new Error("Phase 11 manifest transaction identity is not unique and contiguous.");
}
if (transactions.at(-1)?.actionId !== "REGISTER_PROTECTION_POLICY") {
  throw new Error("Phase 11 transaction 26 is not policy registration.");
}
for (const transaction of transactions) {
  if (
    transaction.safeInclusion?.stage !== "SAFE_CANONICAL" ||
    transaction.finalizedInclusion?.stage !== "FINALIZED_CANONICAL" ||
    transaction.safeInclusion?.receiptStatus !== "SUCCESS" ||
    transaction.finalizedInclusion?.receiptStatus !== "SUCCESS" ||
    !/^0x[0-9a-f]{64}$/iu.test(transaction.safeInclusion.blockHash) ||
    !/^0x[0-9a-f]{64}$/iu.test(transaction.finalizedInclusion.blockHash)
  ) {
    throw new Error(`Phase 11 transaction ${transaction.sequence} lacks strict finality evidence.`);
  }
}

console.log(JSON.stringify({
  status: "PASS",
  chainId: manifest.chainId,
  records: transactions.length,
  reIncluded: transactions.filter((transaction) => transaction.canonicalInclusionClass.includes("REINCLUDED")).map((transaction) => transaction.sequence),
  journalSha256: expected.journal,
  reconciliationSha256: expected.reconciliation,
  manifestSha256: expected.manifest,
  blockchainWrites: 0,
}, null, 2));
