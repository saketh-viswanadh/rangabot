import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/page.tsx", "utf8");
const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
const startRoute = readFileSync("app/api/conversation-turns/route.ts", "utf8");
const conversationRoute = readFileSync("app/api/conversations/[id]/route.ts", "utf8");
const cancelRoute = readFileSync("app/api/conversation-turns/[id]/cancel/route.ts", "utf8");
const turnContract = readFileSync("lib/conversation-turn-contract.ts", "utf8");
const cancellationFlow = page.slice(page.indexOf("async function requestTurnCancellation"), page.indexOf("function parseTurnStartResult"));
const turnStartFlow = page.slice(page.indexOf("async function startConversationTurn"), page.indexOf("function parseBookWelcomeHistory"));
const openFlow = page.slice(page.indexOf("async function openConversation"), page.indexOf("async function attachDatasetToChat"));
const sendFlow = page.slice(page.indexOf("async function sendMessage"), page.indexOf("function stopGenerating"));
const stopFlow = page.slice(page.indexOf("async function stopGenerating"), page.indexOf("function startNewChat"));

test("the browser starts one versioned turn and never replaces a whole transcript", () => {
  assert.match(page, /import \{ CONVERSATION_TURN_PROTOCOL_VERSION \} from "@\/lib\/conversation-turn-contract"/);
  assert.match(turnStartFlow, /fetch\("\/api\/conversation-turns"/);
  assert.match(turnStartFlow, /attempt < 2/);
  assert.match(turnStartFlow, /parseTurnStartResult\(await response\.json\(\), response, expectedTurnId\)/);
  assert.match(page, /turn\?\.id !== expectedTurnId/);
  assert.match(sendFlow, /startConversationTurn\(startPayload, turnId, abortController\.signal\)/);
  assert.doesNotMatch(sendFlow, /startResponse\.json\(\)/);
  assert.match(sendFlow, /fetch\("\/api\/chat"/);
  assert.match(sendFlow, /protocolVersion:\s*CONVERSATION_TURN_PROTOCOL_VERSION,[\s\S]*?conversationId,[\s\S]*?turnId/);
  assert.doesNotMatch(sendFlow, /method:\s*"PUT"/);
  assert.doesNotMatch(sendFlow, /messages:\s*(?:nextMessages|storedMessages)/);
  assert.match(sendFlow, /sendingRef\.current\s*=\s*true/);
});

test("client ownership survives cancellation and navigation races", () => {
  assert.match(cancellationFlow, /return response\.ok/);
  assert.match(cancellationFlow, /return false/);
  assert.match(stopFlow, /authoritativeStatus === "pending"/);
  assert.match(stopFlow, /setAdoptedPendingTurn\(activeTurn\)/);
  assert.match(openFlow, /conversationLoadingRef\.current = true/);
  assert.match(openFlow, /setReplyTo\(null\)/);
  assert.match(sendFlow, /conversationLoadingRef\.current/);
  assert.match(page, /ADOPTED_TURN_POLL_ATTEMPTS/);
  assert.match(page, /turnStatus && turnStatus !== "pending"/);
});

test("terminal request recovery describes its text-only behavior honestly", () => {
  assert.match(page, /function copyTurnRequestText/);
  assert.match(page, />Copy request text<\/span>/);
  assert.doesNotMatch(page, />Reuse request<\/span>/);
});

test("the server owns history, options, replay, and terminal settlement", () => {
  assert.match(chatRoute, /Object\.keys\(value\)\.length === 3/);
  assert.match(chatRoute, /claimConversationTurn\(body\.conversationId, body\.turnId\)/);
  assert.match(chatRoute, /messages:\s*claim\.messages/);
  assert.match(chatRoute, /mode:\s*claim\.turn\.options\.mode/);
  assert.match(chatRoute, /responseFromCompletedAssistant\(claim\.turn\.assistantMessage\)/);
  assert.match(chatRoute, /AbortSignal\.any\(\[request\.signal, AbortSignal\.timeout\(getConversationTurnTimeoutMs\(\)\)\]\)/);
  assert.match(chatRoute, /wrapSuccessfulTurnResponse\(response, callbacks, turnSignal\)/);
  assert.match(chatRoute, /body\.messages\.some\(\(message\) => message\.role === "system"\)/);
});

test("request aborts cannot cancel replayed turns and timeout setup remains terminalizable", () => {
  assert.match(startRoute, /if \(!result\.replayed\) cancelConversationTurn\(result\.turn\.id\)/);

  const versionedFlow = chatRoute.slice(
    chatRoute.indexOf("async function handleVersionedChat"),
    chatRoute.indexOf("async function handleLegacyChat"),
  );
  const callbacksStart = versionedFlow.indexOf("const callbacks = lifecycleCallbacks");
  const protectedStart = versionedFlow.indexOf("try {", callbacksStart);
  const timeoutSetup = versionedFlow.indexOf("getConversationTurnTimeoutMs()");
  const protectedCatch = versionedFlow.indexOf("} catch (error) {", protectedStart);
  assert.ok(callbacksStart >= 0);
  assert.ok(protectedStart > callbacksStart);
  assert.ok(timeoutSetup > protectedStart);
  assert.ok(timeoutSetup < protectedCatch);
  assert.match(versionedFlow, /recordTurnException\(error, callbacks, turnSignal \?\? request\.signal\)/);
});

test("timeline reads expose failures while legacy transcript replacement is locked", () => {
  assert.match(conversationRoute, /getConversationTimeline/);
  assert.match(conversationRoute, /isConversationLifecycleManaged\(id\)/);
  assert.match(conversationRoute, /status:\s*409/);
  assert.match(cancelRoute, /turn\.conversationId !== body\.conversationId/);
  assert.match(cancelRoute, /cancelConversationTurn\(id\)/);
});

test("the protocol version has one browser-safe source of truth", () => {
  assert.match(turnContract, /CONVERSATION_TURN_PROTOCOL_VERSION\s*=\s*2 as const/);
  assert.doesNotMatch(page, /CONVERSATION_TURN_PROTOCOL_VERSION\s*=\s*2/);
  assert.doesNotMatch(chatRoute, /CONVERSATION_TURN_PROTOCOL_VERSION\s*=\s*2/);
});
