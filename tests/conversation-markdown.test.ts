import assert from "node:assert/strict";
import test from "node:test";
import { conversationFilename, parseConversationMarkdown, serializeConversationMarkdown } from "../lib/conversation-markdown.ts";

test("round-trips a readable Markdown conversation without losing message metadata", () => {
  const conversation = {
    id: "local-test",
    title: "Python & SQL plan",
    projectId: null,
    datasetId: null,
    pinned: false,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:01:00.000Z",
    messages: [
      { role: "user" as const, content: "Show me `SELECT 1`." },
      { role: "assistant" as const, content: "```sql\nSELECT 1;\n```", replyTo: { role: "user" as const, excerpt: "Show me SELECT 1" }, memoryUse: "context" as const },
    ],
  };
  const markdown = serializeConversationMarkdown(conversation);
  assert.match(markdown, /^<!-- rangabot-conversation:v1:/);
  assert.match(markdown, /# Python & SQL plan/);
  assert.match(markdown, /## Rangabot/);
  assert.deepEqual(parseConversationMarkdown(markdown), conversation.messages);
  assert.equal(conversationFilename(conversation.title), "python-sql-plan.md");
});

test("rejects arbitrary Markdown and damaged exports", () => {
  assert.throws(() => parseConversationMarkdown("# Notes"), /not a Rangabot conversation export/);
  assert.throws(() => parseConversationMarkdown("<!-- rangabot-conversation:v1:bad -->"), /damaged/);
});
