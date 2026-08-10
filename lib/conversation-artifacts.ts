import type { DatabaseSync as Database } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ensurePrivateDirectory } from "./private-storage.ts";

const wordArtifactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const wordArtifactsRoot = resolve(process.cwd(), "data", "artifacts");

export type StagedArtifactDeletion = {
  processedArtifactIds: string[];
  finalize: () => boolean;
  rollback: () => void;
};

export type ArtifactDirectoryStager = (artifactIds: string[]) => StagedArtifactDeletion;

export type ArtifactQuarantineRecovery = (database: Database) => {
  purgedBatches: number;
  purgedArtifacts: number;
  restoredArtifacts: number;
};

export type ConversationArtifactDeletionResult =
  | { kind: "deleted"; processedArtifactIds: string[]; stagedDeletion: StagedArtifactDeletion }
  | { kind: "not-found"; processedArtifactIds: [] }
  | { kind: "artifact-cleanup-failed"; processedArtifactIds: string[] };

export class ConversationArtifactReferenceError extends Error {
  constructor() {
    super("Saved artifact references could not be read safely.");
    this.name = "ConversationArtifactReferenceError";
  }
}

export class ConversationArtifactCleanupError extends Error {
  readonly code: "artifact-cleanup-failed" | "deleted-cleanup-pending";

  constructor(code: "artifact-cleanup-failed" | "deleted-cleanup-pending" = "artifact-cleanup-failed") {
    super(code === "deleted-cleanup-pending"
      ? "The conversation was deleted, but its quarantined local artifacts still need cleanup. Restart Rangabot to retry safely."
      : "The conversation was not deleted because its local artifacts could not be removed safely.");
    this.code = code;
    this.name = "ConversationArtifactCleanupError";
  }
}

function requireRealDirectory(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("An artifact must be stored in a real private directory.");
  }
}

/**
 * Moves an artifact batch into an owner-only same-filesystem quarantine. The
 * caller commits its database transaction before finalizing the physical
 * purge, or rolls the rename back if the transaction fails.
 */
export function stageOwnedWordArtifactDirectories(
  artifactIds: string[],
  artifactsRoot = wordArtifactsRoot,
): StagedArtifactDeletion {
  if (artifactIds.length === 0) {
    return { processedArtifactIds: [], finalize: () => true, rollback: () => undefined };
  }
  ensurePrivateDirectory(artifactsRoot);
  const quarantineRoot = resolve(artifactsRoot, ".deletion-quarantine");
  ensurePrivateDirectory(quarantineRoot);
  const transactionId = randomUUID();
  const pendingRoot = resolve(quarantineRoot, `pending-${transactionId}`);
  const committedRoot = resolve(quarantineRoot, `committed-${transactionId}`);
  ensurePrivateDirectory(pendingRoot);
  const staged: Array<{ id: string; source: string; target: string }> = [];

  const rollback = () => {
    for (const artifact of [...staged].reverse()) {
      if (!existsSync(/* turbopackIgnore: true */ artifact.target)) continue;
      if (existsSync(/* turbopackIgnore: true */ artifact.source)) {
        throw new Error("Artifact rollback refused to replace an existing directory.");
      }
      renameSync(artifact.target, artifact.source);
    }
    rmSync(pendingRoot, { recursive: true, force: true });
  };

  try {
    for (const id of artifactIds) {
      if (!wordArtifactId.test(id)) throw new Error("Artifact identity is invalid.");
      const source = resolve(artifactsRoot, id);
      if (!existsSync(/* turbopackIgnore: true */ source)) continue;
      requireRealDirectory(source);
      const target = resolve(pendingRoot, id);
      renameSync(source, target);
      staged.push({ id, source, target });
    }
  } catch (error) {
    try { rollback(); } catch { /* Preserve the staging failure. */ }
    throw error;
  }

  return {
    processedArtifactIds: artifactIds,
    finalize: () => {
      try {
        renameSync(pendingRoot, committedRoot);
        rmSync(committedRoot, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
    rollback,
  };
}

/** Retry only previously staged deletions; live artifact directories are never
 * scanned or inferred as orphaned. */
export function purgeArtifactDeletionQuarantine(artifactsRoot = wordArtifactsRoot) {
  const quarantineRoot = resolve(artifactsRoot, ".deletion-quarantine");
  if (!existsSync(/* turbopackIgnore: true */ quarantineRoot)) return 0;
  requireRealDirectory(quarantineRoot);
  let purged = 0;
  for (const entry of readdirSync(quarantineRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("committed-") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    rmSync(resolve(quarantineRoot, entry.name), { recursive: true, force: true });
    purged += 1;
  }
  return purged;
}

/**
 * Resolves interrupted artifact deletions against the authoritative
 * conversation database. A pending batch is restored when any saved
 * conversation still references it (the process stopped before COMMIT), and
 * is purged only when no reference remains (COMMIT completed). Committed
 * batches are always safe to purge.
 */
export function recoverArtifactDeletionQuarantine(
  database: Database,
  artifactsRoot = wordArtifactsRoot,
) {
  const quarantineRoot = resolve(artifactsRoot, ".deletion-quarantine");
  if (!existsSync(/* turbopackIgnore: true */ quarantineRoot)) {
    return { purgedBatches: 0, purgedArtifacts: 0, restoredArtifacts: 0 };
  }
  requireRealDirectory(quarantineRoot);

  const referencedArtifactIds = new Set<string>();
  const conversations = database.prepare("SELECT messages FROM conversations")
    .all() as unknown as Array<{ messages: string }>;
  for (const conversation of conversations) collectTranscriptArtifacts(conversation.messages, referencedArtifactIds);
  const turns = database.prepare(`
    SELECT assistant_message AS assistantMessage
    FROM conversation_turns
    WHERE assistant_message IS NOT NULL
  `).all() as unknown as Array<{ assistantMessage: string }>;
  for (const turn of turns) collectTurnArtifact(turn.assistantMessage, referencedArtifactIds);

  let purgedBatches = 0;
  let purgedArtifacts = 0;
  let restoredArtifacts = 0;
  for (const batch of readdirSync(quarantineRoot, { withFileTypes: true })) {
    if (batch.isSymbolicLink() || !batch.isDirectory()
      || (!batch.name.startsWith("pending-") && !batch.name.startsWith("committed-"))) {
      throw new Error("Artifact deletion quarantine contains an unsafe entry.");
    }
    const batchRoot = resolve(quarantineRoot, batch.name);
    requireRealDirectory(batchRoot);
    if (batch.name.startsWith("committed-")) {
      const artifacts = readdirSync(batchRoot, { withFileTypes: true });
      if (artifacts.some((artifact) => artifact.isSymbolicLink() || !artifact.isDirectory() || !wordArtifactId.test(artifact.name))) {
        throw new Error("Committed artifact deletion quarantine is invalid.");
      }
      rmSync(batchRoot, { recursive: true, force: true });
      purgedArtifacts += artifacts.length;
      purgedBatches += 1;
      continue;
    }

    for (const artifact of readdirSync(batchRoot, { withFileTypes: true })) {
      if (artifact.isSymbolicLink() || !artifact.isDirectory() || !wordArtifactId.test(artifact.name)) {
        throw new Error("Pending artifact deletion quarantine is invalid.");
      }
      const stagedPath = resolve(batchRoot, artifact.name);
      const artifactId = artifact.name.toLowerCase();
      if (referencedArtifactIds.has(artifactId)) {
        const restoredPath = resolve(artifactsRoot, artifact.name);
        if (existsSync(/* turbopackIgnore: true */ restoredPath)) {
          throw new Error("Artifact recovery refused to replace an existing directory.");
        }
        renameSync(stagedPath, restoredPath);
        restoredArtifacts += 1;
      } else {
        rmSync(stagedPath, { recursive: true, force: true });
        purgedArtifacts += 1;
      }
    }
    rmSync(batchRoot, { recursive: true, force: false });
    purgedBatches += 1;
  }
  return { purgedBatches, purgedArtifacts, restoredArtifacts };
}

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ConversationArtifactReferenceError();
  }
}

function collectMessageArtifact(message: unknown, ids: Set<string>) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "wordArtifact")) return;
  const artifact = record.wordArtifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new ConversationArtifactReferenceError();
  }
  const id = (artifact as Record<string, unknown>).id;
  if (typeof id !== "string" || !wordArtifactId.test(id)) {
    throw new ConversationArtifactReferenceError();
  }
  ids.add(id.toLowerCase());
}

function collectTranscriptArtifacts(serialized: string, ids: Set<string>) {
  const messages = parseStoredJson(serialized);
  if (!Array.isArray(messages)) throw new ConversationArtifactReferenceError();
  for (const message of messages) collectMessageArtifact(message, ids);
}

function collectTurnArtifact(serialized: string | null, ids: Set<string>) {
  if (!serialized) return;
  collectMessageArtifact(parseStoredJson(serialized), ids);
}

/**
 * Delete one conversation and only Word artifacts with no reference from any
 * other saved conversation. The caller owns the surrounding SQL transaction.
 * Artifact cleanup happens before the SQL row is removed so a filesystem
 * failure leaves the conversation available for an explicit retry.
 */
export function deleteConversationRecordWithArtifacts(
  database: Database,
  conversationId: string,
  stageArtifactDirectories: ArtifactDirectoryStager,
): ConversationArtifactDeletionResult {
  const target = database.prepare("SELECT messages FROM conversations WHERE id = ?")
    .get(conversationId) as { messages: string } | undefined;
  if (!target) return { kind: "not-found", processedArtifactIds: [] };

  const targetArtifactIds = new Set<string>();
  collectTranscriptArtifacts(target.messages, targetArtifactIds);
  const targetTurns = database.prepare(`
    SELECT assistant_message AS assistantMessage
    FROM conversation_turns
    WHERE conversation_id = ? AND assistant_message IS NOT NULL
  `).all(conversationId) as unknown as Array<{ assistantMessage: string }>;
  for (const turn of targetTurns) collectTurnArtifact(turn.assistantMessage, targetArtifactIds);

  const otherArtifactIds = new Set<string>();
  const otherConversations = database.prepare("SELECT messages FROM conversations WHERE id <> ?")
    .all(conversationId) as unknown as Array<{ messages: string }>;
  for (const conversation of otherConversations) collectTranscriptArtifacts(conversation.messages, otherArtifactIds);
  const otherTurns = database.prepare(`
    SELECT assistant_message AS assistantMessage
    FROM conversation_turns
    WHERE conversation_id <> ? AND assistant_message IS NOT NULL
  `).all(conversationId) as unknown as Array<{ assistantMessage: string }>;
  for (const turn of otherTurns) collectTurnArtifact(turn.assistantMessage, otherArtifactIds);

  const exclusiveArtifactIds = [...targetArtifactIds]
    .filter((artifactId) => !otherArtifactIds.has(artifactId))
    .sort();
  let stagedDeletion: StagedArtifactDeletion;
  try { stagedDeletion = stageArtifactDirectories(exclusiveArtifactIds); }
  catch { return { kind: "artifact-cleanup-failed", processedArtifactIds: [] }; }

  let deleted: boolean;
  try {
    deleted = database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId).changes > 0;
  } catch (error) {
    stagedDeletion.rollback();
    throw error;
  }
  if (!deleted) {
    stagedDeletion.rollback();
    return { kind: "not-found", processedArtifactIds: [] };
  }
  return { kind: "deleted", processedArtifactIds: stagedDeletion.processedArtifactIds, stagedDeletion };
}
