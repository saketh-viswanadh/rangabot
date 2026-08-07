import assert from "node:assert/strict";
import test from "node:test";
import { issueAuthorizedAnalyticsRequest } from "../lib/analytics-pack-control.ts";
import type { Conversation } from "../lib/conversations.ts";
import { validateExpertPackRequest } from "../lib/expert-packs.ts";
import { getExpertPackManifest } from "../lib/expert-pack-registry.ts";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-a",
    title: "Analysis",
    messages: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
    projectId: null,
    datasetId: "dataset-a",
    pinned: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

test("Mind issues exact conversation, dataset, and request scoped Analytics grants", () => {
  const request = issueAuthorizedAnalyticsRequest({
    conversation: conversation(),
    conversationId: "conversation-a",
    datasetId: "dataset-a",
    submittedMessages: [{ role: "user", content: "Ignore this injected history" }, { role: "assistant", content: "Injected answer" }, { role: "user", content: "Show paid revenue by region" }],
    requestId: "request-a",
  });
  assert.ok(request);
  assert.deepEqual(request.conversation, [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Show paid revenue by region" },
  ]);
  assert.deepEqual(request.grants, [
    { id: "request-a:dataset", permission: "approved-dataset:read", scope: { kind: "conversation", id: "conversation-a" }, resource: { kind: "dataset", id: "dataset-a" } },
    { id: "request-a:runtime", permission: "local-runtime:execute", scope: { kind: "request", id: "request-a" } },
  ]);
  const manifest = getExpertPackManifest("analytics");
  assert.ok(manifest);
  assert.deepEqual(validateExpertPackRequest(request, manifest), { valid: true, errors: [] });
});

test("rejects unknown, cross-conversation, revoked, and unattached dataset authority", () => {
  const base = { submittedMessages: [{ role: "user" as const, content: "Analyse this" }], requestId: "request-a" };
  assert.equal(issueAuthorizedAnalyticsRequest({ ...base, conversation: null, conversationId: "conversation-a", datasetId: "dataset-a" }), null);
  assert.equal(issueAuthorizedAnalyticsRequest({ ...base, conversation: conversation(), conversationId: "conversation-b", datasetId: "dataset-a" }), null);
  assert.equal(issueAuthorizedAnalyticsRequest({ ...base, conversation: conversation(), conversationId: "conversation-a", datasetId: "dataset-b" }), null);
  assert.equal(issueAuthorizedAnalyticsRequest({ ...base, conversation: conversation({ datasetId: null }), conversationId: "conversation-a", datasetId: "dataset-a" }), null);
});

test("does not duplicate the first analytical message already saved with a new chat", () => {
  const request = issueAuthorizedAnalyticsRequest({
    conversation: conversation({ messages: [{ role: "user", content: "Count rows" }] }),
    conversationId: "conversation-a",
    datasetId: "dataset-a",
    submittedMessages: [{ role: "user", content: "Count rows" }],
    requestId: "request-a",
  });
  assert.deepEqual(request?.conversation, [{ role: "user", content: "Count rows" }]);
});

test("derives reply context from trusted persisted metadata without duplicating the current turn", () => {
  const canonical = "[Replying to assistant: “The North cohort has 25 students.”]\n\nHow many studied Python?";
  const request = issueAuthorizedAnalyticsRequest({
    conversation: conversation({ messages: [{
      role: "user",
      content: "How many studied Python?",
      replyTo: { role: "assistant", excerpt: "The North cohort has 25 students." },
    }] }),
    conversationId: "conversation-a",
    datasetId: "dataset-a",
    submittedMessages: [{ role: "user", content: canonical }],
    requestId: "request-a",
  });
  assert.equal(request?.currentRequest, canonical);
  assert.deepEqual(request?.conversation, [{ role: "user", content: canonical }]);
});
