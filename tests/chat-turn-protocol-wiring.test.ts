import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/page.tsx", "utf8");
const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
const chatCore = readFileSync("lib/chat-core-dispatch.ts", "utf8");
const startRoute = readFileSync("app/api/conversation-turns/route.ts", "utf8");
const conversationRoute = readFileSync("app/api/conversations/[id]/route.ts", "utf8");
const cancelRoute = readFileSync("app/api/conversation-turns/[id]/cancel/route.ts", "utf8");
const turnContract = readFileSync("lib/conversation-turn-contract.ts", "utf8");
const recoveryCard = readFileSync("app/components/turn-recovery-card.tsx", "utf8");
const cancellationFlow = page.slice(page.indexOf("async function requestTurnCancellation"), page.indexOf("function parseTurnStartResult"));
const turnStartFlow = page.slice(page.indexOf("async function startConversationTurn"), page.indexOf("function parseBookWelcomeHistory"));
const reconcileFlow = page.slice(page.indexOf("const reconcileTurnFromServer"), page.indexOf("const closeMemoryPanel"));
const removeProjectFlow = page.slice(page.indexOf("async function removeProject"), page.indexOf("async function openConversation"));
const openFlow = page.slice(page.indexOf("async function openConversation"), page.indexOf("async function attachDatasetToChat"));
const attachDatasetFlow = page.slice(page.indexOf("async function attachDatasetToChat"), page.indexOf("async function removeConversation"));
const moveConversationFlow = page.slice(page.indexOf("async function moveConversation"), page.indexOf("function beginConversationDrag"));
const sendFlow = page.slice(page.indexOf("async function sendMessage"), page.indexOf("function stopGenerating"));
const ambiguousStartFlow = sendFlow.slice(sendFlow.indexOf("if (!turnStarted && !startReceiptObserved)"));
const stopFlow = page.slice(page.indexOf("async function stopGenerating"), page.indexOf("function startNewChat"));

test("the browser starts one versioned turn and never replaces a whole transcript", () => {
  assert.match(page, /import \{ CONVERSATION_TURN_PROTOCOL_VERSION \} from "@\/lib\/conversation-turn-contract"/);
  assert.match(turnStartFlow, /localApiFetch\("\/api\/conversation-turns"/);
  assert.match(turnStartFlow, /attempt < 2/);
  assert.match(turnStartFlow, /parseTurnStartResult\(await response\.json\(\), response, expectedTurnId\)/);
  assert.match(page, /turn\?\.id !== expectedTurnId/);
  assert.match(sendFlow, /startConversationTurn\(startPayload, turnId, abortController\.signal\)/);
  assert.doesNotMatch(sendFlow, /startResponse\.json\(\)/);
  assert.match(sendFlow, /localApiFetch\("\/api\/chat"/);
  assert.match(sendFlow, /protocolVersion:\s*CONVERSATION_TURN_PROTOCOL_VERSION,[\s\S]*?conversationId,[\s\S]*?turnId/);
  assert.doesNotMatch(sendFlow, /method:\s*"PUT"/);
  assert.doesNotMatch(sendFlow, /messages:\s*(?:nextMessages|storedMessages)/);
  assert.match(sendFlow, /sendingRef\.current\s*=\s*true/);
});

test("client ownership survives cancellation and navigation races", () => {
  assert.match(cancellationFlow, /value\?\.conversationId !== turn\.conversationId/);
  assert.match(cancellationFlow, /status !== "completed" && status !== "cancelled" && status !== "failed"/);
  assert.match(cancellationFlow, /return status/);
  assert.match(cancellationFlow, /return null/);
  assert.match(stopFlow, /authoritativeStatus === "pending"/);
  assert.match(stopFlow, /const authoritativeStatus = reconciledStatus \?\? cancellationStatus/);
  assert.match(stopFlow, /cancellationStatus === "completed"/);
  assert.doesNotMatch(stopFlow, /cancellationConfirmed/);
  assert.match(stopFlow, /setAdoptedPendingTurn\(activeTurn\)/);
  assert.match(sendFlow, /const authoritativeStatus = reconciledStatus \?\? cancellationStatus/);
  assert.match(sendFlow, /const shouldRetainOwnership = authoritativeStatus === "pending"[\s\S]*?\|\| authoritativeStatus === null/);
  assert.match(sendFlow, /authoritativeStatus === "completed"[\s\S]*?saved answer could not be refreshed/);
  assert.match(openFlow, /conversationLoadingRef\.current = true/);
  assert.match(openFlow, /setReplyTo\(null\)/);
  assert.match(sendFlow, /conversationLoadingRef\.current/);
  assert.match(sendFlow, /sendComposerRevision === composerMutationRef\.current/);
  assert.match(sendFlow, /if \(composerUnchanged && allowPreStartComposerRestore\) \{[\s\S]*?setInput\(content\);[\s\S]*?setAttachedCodeContext\(codeContextForRequest\)/);
  assert.match(cancellationFlow, /replayAmbiguousTurnStart[\s\S]*startConversationTurn\(payload, expectedTurnId, timeout\.signal\)/);
  assert.doesNotMatch(cancellationFlow, /response\.status === 404/);
  assert.match(ambiguousStartFlow, /if \(!turnStarted && !startReceiptObserved\)/);
  assert.match(ambiguousStartFlow, /replayAmbiguousTurnStart\(startPayload, turnId\)/);
  assert.match(ambiguousStartFlow, /quarantinedAmbiguousStart = true/);
  assert.match(ambiguousStartFlow, /\(stopped \|\| quarantinedAmbiguousStart\)[\s\S]*requestTurnCancellation/);
  assert.ok(ambiguousStartFlow.indexOf("replayAmbiguousTurnStart") < ambiguousStartFlow.indexOf("requestTurnCancellation"));
  assert.ok(ambiguousStartFlow.indexOf("requestTurnCancellation") < ambiguousStartFlow.indexOf("reconcileTurnFromServer"));
  assert.match(ambiguousStartFlow, /canRestoreTerminalDraft = authoritativeStatus === "cancelled" \|\| authoritativeStatus === "failed"/);
  assert.match(ambiguousStartFlow, /if \(!turnPresented\)[\s\S]*current\.some\(\(message\) => message\.turn\?\.id === turnId\)[\s\S]*userMessage, assistantMessage/);
  assert.doesNotMatch(ambiguousStartFlow, /startingNewConversation/);
  assert.match(reconcileFlow, /parseConversationContextBinding\(data\.conversationBinding\)/);
  assert.match(reconcileFlow, /expectedEpoch === conversationOpenEpochRef\.current[\s\S]*activeConversationIdRef\.current === conversationId/);
  assert.match(reconcileFlow, /activeConversationBindingRef\.current = conversationBinding/);
  assert.ok(reconcileFlow.indexOf("setMessages((current)") < reconcileFlow.indexOf("responseFeedbackBindingMatches("));
  assert.match(page, /ADOPTED_TURN_POLL_ATTEMPTS/);
  assert.match(page, /turnStatus && turnStatus !== "pending"/);
  assert.match(attachDatasetFlow, /Promise<boolean>/);
  assert.match(attachDatasetFlow, /const expectedConversationBinding = activeConversationBindingRef\.current/);
  assert.match(attachDatasetFlow, /JSON\.stringify\(\{ datasetId: dataset\?\.id \?\? null, expectedConversationBinding \}\)/);
  assert.match(attachDatasetFlow, /data\?\.code === "stale-binding"[\s\S]*throw new Error/);
  assert.match(attachDatasetFlow, /reconcileOpenConversationBindings\(targetConversationId, targetEpoch\)/);
  assert.match(attachDatasetFlow, /conversationBinding\.datasetId !== \(dataset\?\.id \?\? null\)/);
  assert.match(attachDatasetFlow, /activeConversationBindingRef\.current\?\.datasetId === \(dataset\?\.id \?\? null\)/);
  assert.match(moveConversationFlow, /const openConversationBinding = changesOpenConversation && activeConversationBindingRef\.current/);
  assert.match(moveConversationFlow, /bindingData\.conversation\.projectId !== conversation\.projectId/);
  assert.match(moveConversationFlow, /JSON\.stringify\(\{ projectId, expectedConversationBinding \}\)/);
  assert.match(moveConversationFlow, /data\?\.code === "stale-binding"[\s\S]*throw new Error/);
  assert.match(removeProjectFlow, /deletionConfirmed[\s\S]*reconcileOpenConversationBindings\(targetConversationId, targetEpoch\)/);
  assert.doesNotMatch(removeProjectFlow, /activeConversationBindingRef\.current = \{ \.\.\.activeConversationBindingRef\.current, projectId: null \}/);
});

test("terminal request recovery revalidates context and waits for an explicit send", () => {
  assert.match(page, /async function restoreTurnRequest/);
  assert.match(page, /parseTurnRecoveryDraft/);
  assert.match(page, /verifyTurnRecoveryDraftHash/);
  assert.match(page, /recoveryBinding:\s*recoveryBindingForRequest/);
  assert.match(page, /shouldRetainRecoveryBindingAfterStartFailure\(responseFailureCode\)/);
  assert.match(page, /excerpt:\s*replyTo\.content\.slice\(0, 500\)/);
  assert.match(page, /const recoveryComposerRevision = composerMutationRef\.current/);
  assert.match(page, /composerMutationRef\.current !== recoveryComposerRevision/);
  assert.match(page, /conversationOpenEpochRef\.current !== recoveryEpoch/);
  assert.match(page, /turnRecoveryAbortRef\.current\?\.abort\(\)/);
  assert.match(page, /signal:\s*recoveryController\.signal/);
  assert.match(openFlow, /cancelTurnRecoveryPreparation\(\)/);
  assert.match(page.slice(page.indexOf("function startNewChat"), page.indexOf("async function restoreTurnRequest")), /cancelTurnRecoveryPreparation\(\)/);
  assert.match(page, /enqueueSerialMutation\(conversationMutationTailRef/);
  assert.match(page, /datasetBindingPendingRef\.current > 0/);
  assert.match(page, /Wait for the chat's dataset or project update to finish before restoring this request/);
  assert.match(page, /conversationBindingUncertainRef\.current[\s\S]*Reopen this chat to reload its local bindings before restoring this request/);
  assert.match(page, /busy=\{sending \|\| conversationLoading \|\| datasetBindingChanging \|\| projectBindingChanging \|\| conversationBindingUncertain \|\| Boolean\(turnRecoveryPreparing\)\}/);
  assert.match(page, /datasetBindingChanging[\s\S]{0,160}profileWorkspaceBlocked/);
  assert.match(page, /targetEpoch === conversationOpenEpochRef\.current[\s\S]*?activeConversationIdRef\.current === targetConversationId/);
  assert.match(page, /targetEpoch === conversationOpenEpochRef\.current && activeConversationIdRef\.current === conversation\.id[\s\S]*?setActiveProjectId\(projectId\);[\s\S]*?setRecoveredTurnBinding\(null\)/);
  assert.match(page, /Review the composer, then press Send/);
  assert.match(recoveryCard, /Nothing runs automatically/);
  assert.doesNotMatch(page, /copyTurnRequestText|>Reuse request<\/span>/);
  assert.doesNotMatch(recoveryCard, /submit|location\.reload/);
});

test("the server owns history, options, replay, and terminal settlement", () => {
  assert.match(chatRoute, /Object\.keys\(value\)\.length === 3/);
  assert.match(chatRoute, /claimConversationTurn\(body\.conversationId, body\.turnId\)/);
  assert.match(chatRoute, /messages:\s*claim\.messages/);
  assert.match(chatRoute, /mode:\s*claim\.turn\.options\.mode/);
  assert.match(chatRoute, /responseFromCompletedAssistant\(claim\.turn\.assistantMessage\)/);
  assert.match(chatRoute, /registerActiveConversationTurn\(body\.turnId/);
  assert.match(chatRoute, /request\.signal,[\s\S]*AbortSignal\.timeout\(getConversationTurnTimeoutMs\(\)\)/);
  assert.match(chatRoute, /releaseActiveTurn = activeTurn\.release/);
  assert.match(chatRoute, /wrapSuccessfulTurnResponse\(response, callbacks, turnSignal\)/);
  assert.doesNotMatch(chatRoute, /handleLegacyChat|isValidChatMessages/);
  assert.match(chatRoute, /A valid versioned conversation turn is required/);
});

test("bounded finish verification runs in the production response path", () => {
  assert.match(chatRoute, /deriveFinishVerificationPlan\(answerContract\)/);
  assert.match(chatRoute, /auditFinishedAnswer\(generated, finishPlan, answerContract\)/);
  assert.match(chatRoute, /buildFinishRepairMessages\(messages, generated, issues\)/);
  assert.match(chatRoute, /chooseFinishedAnswer/);
  const finishPath = chatRoute.slice(chatRoute.indexOf("if (finishPlan.shouldVerify)"), chatRoute.indexOf("const stream = await streamChatWithOllama"));
  assert.ok(finishPath.indexOf("enforceReasoningInvariants") < finishPath.indexOf("auditFinishedAnswer"));
  assert.doesNotMatch(finishPath.slice(finishPath.indexOf("const selection = chooseFinishedAnswer")), /enforceReasoningInvariants/);
  assert.match(chatRoute, /"X-Rangabot-Finish": encodeURIComponent\(JSON\.stringify\(receipt\)\)/);
  assert.doesNotMatch(chatRoute, /buildSemanticRepairMessages|chooseSemanticRepair/);
  assert.match(chatCore, /deterministicArithmeticAnswer\(finishPlan\)/);
  assert.match(chatCore, /"X-Rangabot-Finish"/);
  assert.match(page, /Mechanical checks passed/);
  assert.match(page, /Formatting repaired/);
  assert.match(page, /Manual check needed/);
  assert.match(page, /confirm sentence count around an initialism/);
  assert.match(page, /issueCount === 20 \? "at least 20"/);
  assert.match(page, /exact quoted text/);
  assert.match(page, /complete code fence/);
});

test("one capability plan is selected before execution and its receipt survives the browser path", () => {
  assert.match(chatRoute, /core = await dispatchCoreChat/);
  assert.match(chatRoute, /const activeCapabilityPlan = core\.capabilityPlan/);
  assert.match(chatRoute, /new Set<CapabilityContext>\(core\.usedContexts\)/);
  assert.doesNotMatch(chatRoute, /\n\s*activeCapabilityPlan\s*=/);
  assert.match(chatRoute, /"X-Rangabot-Capability"/);
  assert.match(chatRoute, /activeCapabilityPlan\.route === "word-document"/);
  assert.match(chatRoute, /activeCapabilityPlan\.route === "knowledge-vault"/);
  assert.match(page, /parseCapabilityReceiptHeader/);
  assert.match(page, /How Rangabot handled this/);
  assert.match(page, /responseCapabilityReceipt\?\.status === "clarify"/);
});

test("request aborts cannot cancel replayed turns and timeout setup remains terminalizable", () => {
  assert.match(startRoute, /if \(!result\.replayed\) cancelConversationTurn\(result\.turn\.id\)/);

  const versionedFlow = chatRoute.slice(
    chatRoute.indexOf("async function handleVersionedChat"),
    chatRoute.indexOf("export async function POST"),
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
  assert.doesNotMatch(conversationRoute, /export async function PUT/);
  assert.match(cancelRoute, /turn\.conversationId !== body\.conversationId/);
  assert.match(cancelRoute, /cancelConversationTurn\(id\)/);
  assert.match(cancelRoute, /abortActiveConversationTurn\(id/);
});

test("the protocol version has one browser-safe source of truth", () => {
  assert.match(turnContract, /CONVERSATION_TURN_PROTOCOL_VERSION\s*=\s*2 as const/);
  assert.doesNotMatch(page, /CONVERSATION_TURN_PROTOCOL_VERSION\s*=\s*2/);
  assert.doesNotMatch(chatRoute, /CONVERSATION_TURN_PROTOCOL_VERSION\s*=\s*2/);
});
