import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getKnowledgeStatus, getKnowledgeVectorIndexStatus, hashBuffer, indexedDocumentUsefulCharacters, knowledgeDatabasePath, knowledgeInbox, knowledgeIngestionVersion, knowledgeRoot, listIndexedKnowledgeDocuments, listKnowledgeFiles, rebuildKnowledgeVectorIndex } from "../lib/knowledge.ts";

const command = process.argv[2] ?? "status";
if (command === "init") {
  for (const directory of [knowledgeInbox, `${knowledgeRoot}/indexes`, `${knowledgeRoot}/processed`, `${knowledgeRoot}/backups`]) mkdirSync(directory, { recursive: true });
  console.log(`Knowledge Vault initialized at ${knowledgeRoot}`);
  console.log(`Add private documents to ${knowledgeInbox}, then run npm run knowledge:ingest.`);
} else if (command === "status" || command === "doctor") {
  const status = getKnowledgeStatus();
  console.log(`Documents: ${status.documents}`);
  console.log(`Passages: ${status.chunks}`);
  console.log(`Storage: ${(status.usedBytes / 1024 ** 2).toFixed(1)} MB / ${(status.budgetBytes / 1024 ** 3).toFixed(1)} GB`);
  console.log(`Inbox: ${status.inbox}`);
  console.log(`Embedding model: ${status.embeddingModel}`);
  if (command === "doctor") {
    const problems = [];
    if (status.remainingBytes === 0) problems.push("storage budget exhausted");
    if (status.documents === 0) problems.push("no indexed documents; add a file and run npm run knowledge:ingest");
    const indexed = listIndexedKnowledgeDocuments();
    const files = listKnowledgeFiles().map((path) => ({ path, sha256: hashBuffer(readFileSync(path)) }));
    const incompatibleNames = new Set(status.sources.filter((source) => source.status === "incompatible").map((source) => source.name));
    const incompatible = files.filter((file) => incompatibleNames.has(basename(file.path)));
    const pending = files.filter((file) => !incompatibleNames.has(basename(file.path)) && !indexed.some((document) => document.sha256 === file.sha256));
    const relocated = files.filter((file) => indexed.some((document) => document.sha256 === file.sha256 && document.path !== file.path));
    const stale = indexed.filter((document) => !files.some((file) => file.sha256 === document.sha256));
    const unreadable = indexed.filter((document) => indexedDocumentUsefulCharacters(document.path) < 200);
    const legacy = indexed.filter((document) => document.ingestionVersion < knowledgeIngestionVersion);
    if (pending.length) problems.push(`${pending.length} unindexed file${pending.length === 1 ? "" : "s"}: ${pending.map((file) => basename(file.path)).join(", ")}`);
    if (relocated.length) problems.push(`${relocated.length} moved file${relocated.length === 1 ? "" : "s"} need path repair`);
    if (stale.length) problems.push(`${stale.length} stale index entr${stale.length === 1 ? "y" : "ies"}`);
    if (unreadable.length) problems.push(`${unreadable.length} indexed source${unreadable.length === 1 ? " has" : "s have"} no usable extracted text: ${unreadable.map((document) => basename(document.path)).join(", ")}`);
    if (legacy.length) problems.push(`${legacy.length} indexed source${legacy.length === 1 ? " needs" : "s need"} the hierarchy upgrade`);
    if (pending.length || relocated.length || stale.length || legacy.length) console.log("ACTION: run npm run knowledge:ingest to synchronize the local index");
    if (incompatible.length) console.log(`NOTICE: ${incompatible.length} incompatible file${incompatible.length === 1 ? " was" : "s were"} already examined and skipped: ${incompatible.map((file) => basename(file.path)).join(", ")}`);
    console.log(problems.length ? `WARN: ${problems.join("; ")}` : "PASS: vault is initialized and searchable");
    if (problems.length) process.exitCode = 1;
  }
} else if (command === "vector-index") {
  const before = getKnowledgeVectorIndexStatus();
  console.log(`Vector extension: ${before.available ? "available" : "unavailable; JavaScript fallback remains active"}`);
  const started = Date.now();
  const result = rebuildKnowledgeVectorIndex();
  if (!result.available) process.exitCode = 1;
  else console.log(`Indexed ${result.vectors.toLocaleString()} vectors with ${result.dimensions} dimensions in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
} else if (command === "validate") {
  const manifest = JSON.parse(readFileSync(resolve(knowledgeRoot, "SOURCE_MANIFEST.json"), "utf8")) as { sources?: Array<Record<string, unknown>> };
  const required = ["id", "title", "author", "url", "license", "licenseUrl", "distributionPolicy", "retrievedAt", "subject", "difficulty", "updatePolicy"];
  const problems = (manifest.sources ?? []).flatMap((source, index) => required.filter((field) => source[field] === undefined).map((field) => `source ${index + 1} missing ${field}`));
  if (problems.length) {
    problems.forEach((problem) => console.error(`FAIL: ${problem}`));
    process.exitCode = 1;
  } else console.log(`PASS: ${manifest.sources?.length ?? 0} source records contain required metadata.`);
} else if (command === "backup") {
  if (!existsSync(knowledgeDatabasePath)) {
    console.error("No knowledge index exists to back up.");
    process.exitCode = 1;
  } else {
    const db = new DatabaseSync(knowledgeDatabasePath);
    db.exec("PRAGMA wal_checkpoint(FULL)");
    db.close();
    const backupRoot = resolve(knowledgeRoot, "backups");
    mkdirSync(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const target = resolve(backupRoot, `knowledge-${stamp}.db`);
    copyFileSync(knowledgeDatabasePath, target);
    console.log(`Created local backup: ${target}`);
  }
} else if (command === "rollback") {
  const backupRoot = resolve(knowledgeRoot, "backups");
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter((name) => /^knowledge-.*\.db$/.test(name)).sort().reverse() : [];
  if (!backups[0]) {
    console.error("No local Knowledge Vault backup is available.");
    process.exitCode = 1;
  } else if (!process.argv.includes("--yes")) {
    console.log(`Latest backup: ${backups[0]}`);
    console.log("Rollback replaces the current local index. Stop Rangabot, then confirm with: npm run knowledge:rollback -- --yes");
  } else {
    console.log("Stop Rangabot before rollback so no process is using the index.");
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${knowledgeDatabasePath}${suffix}`)) unlinkSync(`${knowledgeDatabasePath}${suffix}`);
    copyFileSync(resolve(backupRoot, backups[0]), knowledgeDatabasePath);
    console.log(`Restored latest local backup: ${backups[0]}`);
  }
} else {
  console.error(`Unknown knowledge command: ${command}`);
  process.exitCode = 1;
}
