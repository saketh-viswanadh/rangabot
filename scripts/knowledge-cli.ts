import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createKnowledgeBackup, getKnowledgeBackupRetention, listKnowledgeBackups, restoreLatestKnowledgeBackup, validateKnowledgeBackup } from "../lib/knowledge-backups.ts";
import { getKnowledgeStatus, getKnowledgeVectorIndexStatus, knowledgeDatabasePath, knowledgeInbox, knowledgeIngestionVersion, knowledgeRoot, listIndexedDocumentUsefulCharacters, listIndexedKnowledgeDocuments, listKnowledgeFiles, rebuildKnowledgeVectorIndex } from "../lib/knowledge.ts";
import { getKnowledgeDoctorTimeoutMs, inspectKnowledgeFileHashes } from "../lib/knowledge-doctor.ts";
import { ensurePrivateDirectory } from "../lib/private-storage.ts";

const command = process.argv[2] ?? "status";
if (command === "init") {
  for (const directory of [knowledgeInbox, `${knowledgeRoot}/indexes`, `${knowledgeRoot}/processed`, `${knowledgeRoot}/backups`]) ensurePrivateDirectory(directory);
  console.log(`Knowledge Vault initialized at ${knowledgeRoot}`);
  console.log(`Add private documents to ${knowledgeInbox}, then run npm run knowledge:ingest.`);
} else if (command === "status" || command === "doctor") {
  const status = getKnowledgeStatus();
  console.log(`Documents: ${status.documents}`);
  console.log(`Passages: ${status.chunks}`);
  console.log(`Storage: ${(status.usedBytes / 1024 ** 2).toFixed(1)} MB / ${(status.budgetBytes / 1024 ** 3).toFixed(1)} GB`);
  console.log(`Inbox: ${knowledgeInbox}`);
  console.log(`Embedding model: ${status.embeddingModel}`);
  if (command === "doctor") {
    const problems = [];
    if (status.remainingBytes === 0) problems.push("storage budget exhausted");
    if (status.documents === 0) problems.push("no indexed documents; add a file and run npm run knowledge:ingest");
    const indexed = listIndexedKnowledgeDocuments();
    const knowledgeFiles = listKnowledgeFiles();
    const timeoutMs = getKnowledgeDoctorTimeoutMs();
    console.log(`Deep synchronization check: streaming ${knowledgeFiles.length} file signature${knowledgeFiles.length === 1 ? "" : "s"} (timeout ${(timeoutMs / 1000).toFixed(0)}s)`);
    const scan = await inspectKnowledgeFileHashes(knowledgeFiles, timeoutMs);
    const files = scan.files;
    const incompatibleNames = new Set(status.sources.filter((source) => source.status === "incompatible").map((source) => source.name));
    const incompatible = knowledgeFiles.filter((path) => incompatibleNames.has(basename(path)));
    const pending = scan.complete ? files.filter((file) => !incompatibleNames.has(basename(file.path)) && !indexed.some((document) => document.sha256 === file.sha256)) : [];
    const relocated = scan.complete ? files.filter((file) => indexed.some((document) => document.sha256 === file.sha256 && document.path !== file.path)) : [];
    const stale = scan.complete ? indexed.filter((document) => !files.some((file) => file.sha256 === document.sha256)) : [];
    const usefulCharacters = new Map(listIndexedDocumentUsefulCharacters().map((document) => [document.path, document.usefulCharacters]));
    const unreadable = indexed.filter((document) => (usefulCharacters.get(document.path) ?? 0) < 200);
    const legacy = indexed.filter((document) => document.ingestionVersion < knowledgeIngestionVersion);
    if (pending.length) problems.push(`${pending.length} unindexed file${pending.length === 1 ? "" : "s"}: ${pending.map((file) => basename(file.path)).join(", ")}`);
    if (relocated.length) problems.push(`${relocated.length} moved file${relocated.length === 1 ? "" : "s"} need path repair`);
    if (stale.length) problems.push(`${stale.length} stale index entr${stale.length === 1 ? "y" : "ies"}`);
    if (unreadable.length) problems.push(`${unreadable.length} indexed source${unreadable.length === 1 ? " has" : "s have"} no usable extracted text: ${unreadable.map((document) => basename(document.path)).join(", ")}`);
    if (legacy.length) problems.push(`${legacy.length} indexed source${legacy.length === 1 ? " needs" : "s need"} the hierarchy upgrade`);
    if (!scan.complete) problems.push(`deep synchronization check timed out after ${(timeoutMs / 1000).toFixed(0)}s; rerun with KNOWLEDGE_DOCTOR_TIMEOUT_MS up to 300000 for a complete scan`);
    if (pending.length || relocated.length || stale.length || legacy.length) console.log("ACTION: run npm run knowledge:ingest to synchronize the local index");
    if (incompatible.length) console.log(`NOTICE: ${incompatible.length} incompatible file${incompatible.length === 1 ? " was" : "s were"} already examined and skipped: ${incompatible.map((path) => basename(path)).join(", ")}`);
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
  try {
    const result = await createKnowledgeBackup({
      databasePath: knowledgeDatabasePath,
      backupRoot: resolve(knowledgeRoot, "backups"),
      retention: getKnowledgeBackupRetention(),
    });
    console.log(`Created validated private Knowledge index database backup: ${result.name}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Knowledge backup failed.");
    process.exitCode = 1;
  }
} else if (command === "rollback") {
  const backupRoot = resolve(knowledgeRoot, "backups");
  const backups = listKnowledgeBackups(backupRoot);
  if (!backups[0]) {
    console.error("No local Knowledge index database backup is available.");
    process.exitCode = 1;
  } else if (!process.argv.includes("--yes")) {
    try {
      const validation = validateKnowledgeBackup(backups[0].path);
      console.log(`Latest backup: ${backups[0].name}`);
      console.log(`Integrity: SQLite valid; checksum ${validation.checksumVerified ? "verified" : "unavailable for this legacy backup"}`);
      console.log("Rollback replaces the current local index. Stop Rangabot, then confirm with: npm run knowledge:rollback -- --yes");
    } catch (error) {
      console.error(error instanceof Error ? error.message : "The latest Knowledge index database backup is invalid.");
      process.exitCode = 1;
    }
  } else {
    try {
      console.log("Stop Rangabot before rollback so no process is using the index.");
      const result = await restoreLatestKnowledgeBackup({
        databasePath: knowledgeDatabasePath,
        backupRoot,
        retention: getKnowledgeBackupRetention(),
      });
      console.log(`Restored validated local backup: ${result.restored}`);
      if (!result.checksumVerified) console.log("NOTICE: this legacy backup predated checksum sidecars; SQLite integrity was verified before restore.");
      if (result.recoveryBackup) console.log(`Preserved the replaced index as recovery backup: ${result.recoveryBackup}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Knowledge rollback failed.");
      process.exitCode = 1;
    }
  }
} else {
  console.error(`Unknown knowledge command: ${command}`);
  process.exitCode = 1;
}
