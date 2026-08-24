import type { DesktopArtifactFile } from "./desktop-artifact-identity.ts";

const stagedResourcePrefix = "rangabot-resources/";

function bytewiseCompare(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sortedFiles(files: readonly DesktopArtifactFile[]) {
  return files
    .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    .sort((left, right) => bytewiseCompare(left.path, right.path));
}

function sameFiles(left: readonly DesktopArtifactFile[], right: readonly DesktopArtifactFile[]) {
  return left.length === right.length && left.every((file, index) => (
    file.path === right[index]?.path
    && file.bytes === right[index]?.bytes
    && file.sha256 === right[index]?.sha256
  ));
}

/**
 * Forge copies the prepared resource tree into an outer platform bundle. The
 * finalizer must prove that every copied byte still matches the prepared,
 * source-bound manifest before it signs code or creates a replacement
 * manifest. Otherwise a post-prepare mutation could be re-hashed as if it were
 * the reviewed input.
 */
export function reconcileCopiedDesktopResources(
  stagedResources: readonly DesktopArtifactFile[],
  unsignedArtifactResources: readonly DesktopArtifactFile[],
) {
  const staged = sortedFiles(stagedResources);
  const copied = sortedFiles(unsignedArtifactResources
    .filter((file) => file.path.startsWith(stagedResourcePrefix))
    .map((file) => ({
      path: file.path.slice(stagedResourcePrefix.length),
      bytes: file.bytes,
      sha256: file.sha256,
    })));
  if (!sameFiles(staged, copied)) {
    throw new Error("Forge-copied rangabot-resources do not exactly match the staged resource manifest.");
  }
  return Object.freeze(copied.map((file) => Object.freeze({ ...file })));
}
