import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const collectionRoute = readFileSync("app/api/conversations/route.ts", "utf8");
const conversationRoute = readFileSync("app/api/conversations/[id]/route.ts", "utf8");

test("browser conversation routes cannot author trusted assistant provenance", () => {
  assert.doesNotMatch(collectionRoute, /export async function POST/);
  assert.doesNotMatch(conversationRoute, /export async function PUT/);
  assert.doesNotMatch(collectionRoute, /createConversation|isValidChatMessages/);
  assert.doesNotMatch(conversationRoute, /updateConversation|isValidChatMessages/);
});
