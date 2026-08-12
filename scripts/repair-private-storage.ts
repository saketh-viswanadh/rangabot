import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { hardenPrivateTree, UnsafePrivateStoragePathError } from "../lib/private-storage.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";
import { inspectProfileRegistry } from "../lib/profile-registry.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";

export const managedPaths = [
  ".env.local",
  "data/rangabot.db",
  "data/rangabot.db-wal",
  "data/rangabot.db-shm",
  "data/rangabot-memory.db",
  "data/rangabot-memory.db-wal",
  "data/rangabot-memory.db-shm",
  "data/datasets.json",
  "data/repositories.json",
  "data/sql-confirmations.json",
  "data/artifacts",
  "data/knowledge/inbox",
  "data/knowledge/processed",
  "data/knowledge/indexes",
  "data/knowledge/backups",
  "data/knowledge/evaluations",
  "data/evaluations/results",
  "work",
  "outputs",
];

const configuredDataPaths = [
  "rangabot.db",
  "rangabot.db-wal",
  "rangabot.db-shm",
  "rangabot-memory.db",
  "rangabot-memory.db-wal",
  "rangabot-memory.db-shm",
  "datasets.json",
  "repositories.json",
  "sql-confirmations.json",
  "artifacts",
  "knowledge/inbox",
  "knowledge/processed",
  "knowledge/indexes",
  "knowledge/backups",
  "knowledge/evaluations",
  "evaluations/results",
];

export function repairPrivateStorage(
  root = inspectProfileRegistry(runtimePaths.managedDataRoot).kind === "ready"
    ? runtimePaths.dataRoot
    : runtimePaths.mode === "cli" ? runtimePaths.resourceRoot : runtimePaths.dataRoot,
  paths = inspectProfileRegistry(runtimePaths.managedDataRoot).kind === "ready"
    ? configuredDataPaths
    : runtimePaths.mode === "cli" ? managedPaths : configuredDataPaths,
) {
  const repaired = { directories: 0, files: 0, skippedPaths: [] as string[] };
  for (const path of paths) {
    try {
      const result = hardenPrivateTree(resolve(root, path), { skipNestedSymlinks: true, trustedRoot: root });
      repaired.directories += result.directories;
      repaired.files += result.files;
    } catch (error) {
      if (!(error instanceof UnsafePrivateStoragePathError)) throw error;
      repaired.skippedPaths.push(path);
    }
  }
  return repaired;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Private storage repair" });
  profileMaintenance.assertCurrent();
  const repaired = repairPrivateStorage();
  const skipped = repaired.skippedPaths.length
    ? ` ${repaired.skippedPaths.length} unsafe app-managed path(s) were skipped.`
    : "";
  console.log(`Private storage permissions repaired: ${repaired.directories} directories and ${repaired.files} files. Nested symbolic links were skipped and never followed.${skipped}`);
  profileMaintenance.release();
}
