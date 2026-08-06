import { randomUUID } from "node:crypto";
import type { Conversation } from "./conversations.ts";
import { getExpertPackManifest } from "./expert-pack-registry.ts";
import type { ExpertPackGrant, ExpertPackManifest, ExpertPackRequest } from "./expert-packs.ts";
import type { ChatMessage } from "./providers/types.ts";

function analyticsManifest(): ExpertPackManifest {
  const manifest = getExpertPackManifest("analytics");
  if (!manifest) throw new Error("The bundled Analytics Expert Pack manifest is missing.");
  return manifest;
}

function boundedConversation(persisted: ChatMessage[], submitted: ChatMessage[]) {
  const conversation = persisted
    .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map(({ role, content, replyTo }) => ({
      role,
      content: replyTo
        ? `[Replying to ${replyTo.role}: “${replyTo.excerpt}”]\n\n${content}`
        : content,
    }));
  const current = [...submitted]
    .reverse()
    .find((message): message is ChatMessage & { role: "user" } => message.role === "user");
  if (!current) return null;
  const final = conversation.at(-1);
  if (!final || final.role !== "user" || final.content !== current.content) conversation.push({ role: "user", content: current.content });
  return { conversation, currentRequest: current.content };
}

/**
 * Mind & Memory owns this authority boundary. The pack can consume these
 * request-scoped grants, but it cannot mint or widen them itself.
 */
export function issueAuthorizedAnalyticsRequest(input: {
  conversation: Conversation | null;
  conversationId: string;
  datasetId: string;
  submittedMessages: ChatMessage[];
  requestId?: string;
}): ExpertPackRequest | null {
  if (!input.conversation || input.conversation.id !== input.conversationId || input.conversation.datasetId !== input.datasetId) return null;
  const context = boundedConversation(input.conversation.messages, input.submittedMessages);
  if (!context) return null;
  const manifest = analyticsManifest();
  const requestId = input.requestId ?? randomUUID();
  const grants: ExpertPackGrant[] = [
    { id: `${requestId}:dataset`, permission: "approved-dataset:read", scope: { kind: "conversation", id: input.conversationId }, resource: { kind: "dataset", id: input.datasetId } },
    { id: `${requestId}:runtime`, permission: "local-runtime:execute", scope: { kind: "request", id: requestId } },
  ];
  return {
    requestId,
    conversationId: input.conversationId,
    packId: manifest.id,
    packVersion: manifest.version,
    capability: "conversational-sql",
    currentRequest: context.currentRequest,
    conversation: context.conversation,
    grants,
    modelAssignment: { mode: "general", requestOverride: false },
    contextReferences: [{ id: input.datasetId, kind: "dataset", title: "Conversation-attached local dataset" }],
  };
}
