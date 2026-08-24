import { getConversation, type Conversation } from "./conversations.ts";
import { conversationTurnRequestHash, getConversationTurn, type ConversationTurn } from "./conversation-turns.ts";
import { getApprovedDataset, type ApprovedDataset } from "./datasets.ts";
import { getAllowedRepository, type AllowedRepository } from "./repositories.ts";
import { codePreviewSha256, previewRepositoryFile, type CodePreview } from "./repository-search.ts";
import { inspectDatasetIdentity } from "./sql-runtime.ts";
import { parseTurnRecoveryDraft, TURN_RECOVERY_VERSION, type TurnRecoveryDraft } from "./turn-recovery.ts";

export class TurnRecoveryPreparationError extends Error {
  readonly code: "not-found" | "not-terminal" | "binding-changed" | "resource-changed" | "integrity";
  constructor(code: TurnRecoveryPreparationError["code"], message: string) {
    super(message);
    this.name = "TurnRecoveryPreparationError";
    this.code = code;
  }
}

export type TurnRecoveryDependencies = {
  conversation(id: string): Conversation | null;
  turn(id: string): ConversationTurn | null;
  dataset(id: string): ApprovedDataset | null;
  inspectDataset(dataset: ApprovedDataset, signal?: AbortSignal): Promise<void>;
  repository(id: string): AllowedRepository | null;
  preview(repository: AllowedRepository, path: string, line: number): CodePreview;
};

const defaultDependencies: TurnRecoveryDependencies = {
  conversation: getConversation,
  turn: getConversationTurn,
  dataset: getApprovedDataset,
  inspectDataset: async (dataset, signal) => { await inspectDatasetIdentity(dataset.path, { expectedFileIdentity: dataset.fileIdentity, signal }); },
  repository: getAllowedRepository,
  preview: previewRepositoryFile,
};

export async function prepareTurnRecovery(
  sourceTurnId: string,
  conversationId: string,
  dependencies: TurnRecoveryDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<TurnRecoveryDraft> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
  const turn = dependencies.turn(sourceTurnId);
  if (!turn || turn.conversationId !== conversationId) throw new TurnRecoveryPreparationError("not-found", "Conversation turn not found.");
  if (turn.status !== "failed" && turn.status !== "cancelled") {
    throw new TurnRecoveryPreparationError("not-terminal", "Only a stopped or failed request can be restored.");
  }
  const conversation = dependencies.conversation(conversationId);
  if (!conversation) throw new TurnRecoveryPreparationError("not-found", "Conversation not found.");
  if (!Object.prototype.hasOwnProperty.call(turn.options, "projectId")) {
    throw new TurnRecoveryPreparationError("binding-changed", "This older failed request has no exact project binding receipt. Review the current chat and send a new request instead.");
  }
  const projectId = turn.options.projectId ?? null;
  const datasetId = turn.options.datasetId ?? null;
  if (conversation.projectId !== projectId || conversation.datasetId !== datasetId) {
    throw new TurnRecoveryPreparationError("binding-changed", "This chat's project or dataset changed after the failed request. Restore the original binding before trying again.");
  }
  if (conversation.messages.length !== turn.contextMessageCount) {
    throw new TurnRecoveryPreparationError("binding-changed", "This chat continued after the failed request. Start a new request from the current conversation instead of restoring stale context.");
  }
  if (conversationTurnRequestHash(turn.userMessage, turn.options) !== turn.requestHash) {
    throw new TurnRecoveryPreparationError("integrity", "The saved request no longer matches its integrity receipt.");
  }
  let datasetSha256: string | null = null;
  if (datasetId) {
    const dataset = dependencies.dataset(datasetId);
    if (!dataset || !turn.options.datasetSha256 || dataset.fileIdentity.sha256 !== turn.options.datasetSha256) {
      throw new TurnRecoveryPreparationError("resource-changed", "The original dataset is no longer approved with the same content. Review and attach it again before restoring this request.");
    }
    try { await dependencies.inspectDataset(dataset, signal); }
    catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new TurnRecoveryPreparationError("resource-changed", "The original dataset changed or is unavailable. Review and attach it again before restoring this request.");
    }
    datasetSha256 = dataset.fileIdentity.sha256;
  }

  let codeContext: TurnRecoveryDraft["codeContext"];
  if (turn.options.codeContext) {
    if (!turn.options.codeContext.previewSha256) {
      throw new TurnRecoveryPreparationError("resource-changed", "This older code attachment has no content receipt. Review and attach it again before restoring this request.");
    }
    const repository = dependencies.repository(turn.options.codeContext.repositoryId);
    if (!repository) throw new TurnRecoveryPreparationError("resource-changed", "The original repository is no longer approved. Approve it again before restoring this request.");
    let preview: CodePreview;
    try { preview = dependencies.preview(repository, turn.options.codeContext.path, turn.options.codeContext.line); }
    catch (error) {
      throw new TurnRecoveryPreparationError("resource-changed", error instanceof Error ? error.message : "The original code context could not be revalidated.");
    }
    if (preview.path !== turn.options.codeContext.path || preview.focusLine !== turn.options.codeContext.line
      || codePreviewSha256(preview) !== turn.options.codeContext.previewSha256
      || !turn.userMessage.codeContext || turn.userMessage.codeContext.repository !== repository.name
      || turn.userMessage.codeContext.path !== preview.path || turn.userMessage.codeContext.startLine !== preview.startLine
      || turn.userMessage.codeContext.endLine !== preview.startLine + preview.lines.length - 1) {
      throw new TurnRecoveryPreparationError("resource-changed", "The original code excerpt changed. Review and attach it again before retrying.");
    }
    codeContext = {
      repositoryId: repository.id,
      repositoryName: repository.name,
      path: preview.path,
      line: preview.focusLine,
      startLine: preview.startLine,
      endLine: preview.startLine + preview.lines.length - 1,
      characterCount: preview.lines.join("\n").length,
      previewSha256: turn.options.codeContext.previewSha256,
    };
  } else if (turn.userMessage.codeContext) {
    throw new TurnRecoveryPreparationError("integrity", "The saved request has inconsistent code context.");
  }

  if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
  const finalConversation = dependencies.conversation(conversationId);
  const finalDataset = datasetId ? dependencies.dataset(datasetId) : null;
  if (!finalConversation || finalConversation.projectId !== projectId || finalConversation.datasetId !== datasetId
    || finalConversation.messages.length !== turn.contextMessageCount
    || (datasetId && (!finalDataset || finalDataset.fileIdentity.sha256 !== datasetSha256))) {
    throw new TurnRecoveryPreparationError("binding-changed", "This chat or its local data changed while recovery was being prepared. Nothing was restored.");
  }

  const normalizedOptions = {
    mode: turn.options.mode,
    ...(codeContext ? { codeContext: {
      repositoryId: codeContext.repositoryId,
      path: codeContext.path,
      line: codeContext.line,
      previewSha256: codeContext.previewSha256,
    } } : {}),
    datasetId,
    datasetSha256,
    projectId,
  };
  const draft: TurnRecoveryDraft = {
    version: TURN_RECOVERY_VERSION,
    sourceTurnId: turn.id,
    requestHash: conversationTurnRequestHash(turn.userMessage, normalizedOptions),
    failureCode: turn.failureCode ?? (turn.status === "cancelled" ? "cancelled" : "internal"),
    message: turn.userMessage,
    mode: turn.options.mode,
    binding: { conversationId, projectId, datasetId, datasetSha256, contextMessageCount: turn.contextMessageCount },
    ...(codeContext ? { codeContext } : {}),
  };
  if (!parseTurnRecoveryDraft(draft)) throw new TurnRecoveryPreparationError("integrity", "The saved request could not be reconstructed safely.");
  return draft;
}
