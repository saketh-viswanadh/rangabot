"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONVERSATION_TURN_PROTOCOL_VERSION } from "@/lib/conversation-turn-contract";
import {
  downloadLocalApiFile,
  isLegacyLocalProfileContext,
  localApiBlob,
  localApiFetch,
  profileScopedStorageKey,
} from "@/lib/local-api-client";
import type { ChatMessage, ConversationTurnStatus, ProviderStatus } from "@/lib/providers/types";
import { appendWelcomeHistory, chooseWelcomeIndex, parseWelcomeHistory, WELCOME_HISTORY_STORAGE_KEY, welcomeLines } from "@/lib/welcome-content";
import { chooseGreetingIndex, formatWelcomeGreeting } from "@/lib/welcome-greeting";
import {
  defaultWelcomePreferences,
  parseWelcomePreferences,
  WELCOME_PREFERENCES_STORAGE_KEY,
  type WelcomeMode,
  type WelcomePreferences,
} from "@/lib/welcome-preferences";
import type { BookWelcomeFact, BookWelcomeResponse } from "@/lib/knowledge-welcome";
import { isNearMessageBottom } from "@/lib/message-scroll";
import { parseKnowledgeBrief } from "@/lib/knowledge-brief";
import { CraftIcon } from "@/app/components/craft-icon";
import { formatAnswerReceipt } from "@/lib/answer-receipt";
import { SqlAnalysisPanel } from "@/app/components/sql-analysis-panel";
import { WelcomePreferencesDialog } from "@/app/components/welcome-preferences";
import { ResponseFeedback } from "@/app/components/response-feedback";
import { ModelManager } from "@/app/components/model-manager";
import { ProfileManager } from "@/app/components/profile-manager";
import type { ResponseFeedbackRating, ResponseFeedbackView } from "@/lib/response-feedback-contract";
import type { DesktopPreferences } from "@/lib/desktop-preferences";
import { mergeResponseFeedbackRead, responseFeedbackBindingMatches } from "@/lib/response-feedback-client-state";
import type { AttachedDataset, SqlDraft } from "@/lib/sql-display";
import { parseAnalysisTraceHeader, parsePackWarningCodesHeader } from "@/lib/chat-validation";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_PALETTE,
  PALETTE_STORAGE_KEY,
  normalizeStoredPalette,
  parseAppearance,
  type Appearance,
  type Palette,
} from "@/lib/appearance-preferences";

const MemoryPanel = dynamic(
  () => import("@/app/components/memory-panel").then((module) => module.MemoryPanel),
  { ssr: false },
);
const MarkdownMessage = dynamic(
  () => import("@/components/MarkdownMessage").then((module) => module.MarkdownMessage),
  { ssr: false, loading: () => <span className="message-loading">Preparing response…</span> },
);

type Mode = "local" | "smart" | "teach" | "codex";
type DisplayMessage = ChatMessage & {
  id: string;
  source?: "local";
  error?: boolean;
  active?: boolean;
  stopped?: boolean;
  knowledgeUsed?: boolean;
  retrievalMode?: "hybrid" | "keyword-only";
};
type ConversationSummary = {
  id: string;
  title: string;
  projectId: string | null;
  datasetId: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};
type ProjectSummary = { id: string; name: string; createdAt: string; updatedAt: string };
type AllowedRepository = { id: string; name: string; path: string; addedAt: string };
type CodeSearchResult = { path: string; line: number; excerpt: string };
type CodePreview = { path: string; startLine: number; focusLine: number; lines: string[] };
type AttachedCodeContext = { repositoryId: string; repositoryName: string; path: string; line: number; startLine: number; endLine: number; characterCount: number };
type KnowledgeSourceState = { name: string; status: "indexed" | "pending" | "incompatible"; detail: string; chunks: number };
type KnowledgeStatus = { usedBytes: number; budgetBytes: number; documents: number; chunks: number; incompatible: number; pending: number; sources: KnowledgeSourceState[] };
type KnowledgeUpdates = { week: string; month: string; changelog: string; weekUpdatedAt: string | null };
type KnowledgeTab = "discover" | "vault" | "updates";
type ActiveConversationTurn = { conversationId: string; turnId: string };
type TurnStartResult = { ok: boolean; conversationId?: string; error?: string; code?: string };
type LegacyPreferencesPreview = Pick<DesktopPreferences, "preferredName" | "welcomeMode" | "appearance" | "palette">;
const BOOK_WELCOME_HISTORY_STORAGE_KEY = "rangabot-book-welcome-history-v1";
const TURN_CANCELLATION_TIMEOUT_MS = 2_500;
const ADOPTED_TURN_POLL_INTERVAL_MS = 2_000;
const ADOPTED_TURN_POLL_ATTEMPTS = 480;
const PUBLIC_DEMO_MODES = new Set(["knowledge", "welcome"]);

function displayMessagesFromTimeline(messages: ChatMessage[]): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  for (const message of messages) {
    const status = message.turn?.status;
    display.push({
      ...message,
      id: message.turn ? `${message.turn.id}:${message.role}` : crypto.randomUUID(),
      source: message.role === "assistant" && status !== "failed" ? "local" : undefined,
      active: message.role === "assistant" && status === "pending",
      stopped: message.role === "assistant" && status === "cancelled",
      error: message.role === "assistant" && status === "failed",
      knowledgeUsed: Boolean(message.knowledgeUsed || message.retrievalMode),
    });
    if (message.role === "user" && message.turn?.status === "pending") {
      display.push({
        id: `${message.turn.id}:assistant`,
        role: "assistant",
        content: "",
        source: "local",
        active: true,
        turn: message.turn,
      });
    }
  }
  return display;
}

function responseFeedbackMap(value: unknown) {
  const feedback: Record<string, ResponseFeedbackRating | null> = {};
  if (!Array.isArray(value)) return feedback;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Partial<ResponseFeedbackView>;
    if (typeof record.turnId !== "string" || !/^[0-9a-f-]{36}$/i.test(record.turnId)) continue;
    if (record.rating !== null && record.rating !== "helpful" && record.rating !== "needs-improvement") continue;
    feedback[record.turnId] = record.rating;
  }
  return feedback;
}

async function requestTurnCancellation(turn: ActiveConversationTurn, keepalive = false) {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), TURN_CANCELLATION_TIMEOUT_MS);
  try {
    const response = await localApiFetch(`/api/conversation-turns/${turn.turnId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: turn.conversationId }),
      keepalive,
      signal: timeout.signal,
    });
    return response.ok;
  } catch {
    // The server-side stream lifecycle also records cancellation when the
    // connection closes. This explicit request covers pre-stream abandons.
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function parseTurnStartResult(value: unknown, response: Response, expectedTurnId: string): TurnStartResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The local turn returned an invalid start receipt.");
  }
  const record = value as Record<string, unknown>;
  const conversationId = typeof record.conversationId === "string" && record.conversationId ? record.conversationId : undefined;
  const error = typeof record.error === "string" && record.error ? record.error : undefined;
  const code = typeof record.code === "string" && record.code ? record.code : undefined;
  const turn = record.turn && typeof record.turn === "object" && !Array.isArray(record.turn)
    ? record.turn as Record<string, unknown>
    : undefined;
  const validTurnStatus = turn?.status === "pending" || turn?.status === "completed"
    || turn?.status === "cancelled" || turn?.status === "failed";
  if (response.ok && (!conversationId || turn?.id !== expectedTurnId || !validTurnStatus)) {
    throw new Error("The local turn returned an incomplete start receipt.");
  }
  return { ok: response.ok, ...(conversationId ? { conversationId } : {}), ...(error ? { error } : {}), ...(code ? { code } : {}) };
}

async function startConversationTurn(payload: string, expectedTurnId: string, signal: AbortSignal): Promise<TurnStartResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await localApiFetch("/api/conversation-turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal,
      });
      const result = parseTurnStartResult(await response.json(), response, expectedTurnId);
      if (response.status < 500 || attempt === 1) return result;
      lastError = new Error(result.error ?? "The local turn could not be started.");
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === 1) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The local turn could not be started.");
}

function parseBookWelcomeHistory() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(profileScopedStorageKey(BOOK_WELCOME_HISTORY_STORAGE_KEY)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string" && /^wf_[A-Za-z0-9_-]{20}$/.test(id)).slice(-60);
  } catch {
    return [];
  }
}

/**
 * Reads only the current private loopback origin. Packaged Rangabot never
 * scans browser profiles or other historical ports. The result is a preview;
 * it is not applied or copied until the user confirms the import.
 */
function readSameOriginLegacyPreferencePreview(): LegacyPreferencesPreview | null {
  try {
    if (!isLegacyLocalProfileContext()) return null;
    const welcomeValue = localStorage.getItem(WELCOME_PREFERENCES_STORAGE_KEY);
    const appearanceValue = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    const paletteValue = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (welcomeValue === null && appearanceValue === null && paletteValue === null) return null;
    const welcome = parseWelcomePreferences(welcomeValue);
    return {
      preferredName: welcome.preferredName ?? "",
      welcomeMode: welcome.mode,
      appearance: parseAppearance(appearanceValue),
      palette: normalizeStoredPalette(paletteValue).palette,
    };
  } catch {
    return null;
  }
}

export default function Home() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [responseFeedback, setResponseFeedback] = useState<Record<string, ResponseFeedbackRating | null>>({});
  const [responseFeedbackGeneration, setResponseFeedbackGeneration] = useState(0);
  const [publicDemo, setPublicDemo] = useState(false);
  const [welcomeIndex, setWelcomeIndex] = useState(0);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [welcomePreferences, setWelcomePreferences] = useState<WelcomePreferences>({ ...defaultWelcomePreferences });
  const [welcomePreferencesReady, setWelcomePreferencesReady] = useState(false);
  const [welcomePreferencesOpen, setWelcomePreferencesOpen] = useState(false);
  const [bookWelcomeFact, setBookWelcomeFact] = useState<BookWelcomeFact | null>(null);
  const [bookWelcomeLoading, setBookWelcomeLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("smart");
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  const [desktopPreferencesRevision, setDesktopPreferencesRevision] = useState(0);
  const [preferencesMessage, setPreferencesMessage] = useState("");
  const [legacyPreferencesPreview, setLegacyPreferencesPreview] = useState<LegacyPreferencesPreview | null>(null);
  const [replyTo, setReplyTo] = useState<DisplayMessage | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [profileSwitching, setProfileSwitching] = useState(false);
  const [profileRecoveryRequired, setProfileRecoveryRequired] = useState(false);
  const [activeProfileContext, setActiveProfileContext] = useState<{ marker: string; kind: "default" | "personal" | "testing" } | null>(null);
  const [wordPreview, setWordPreview] = useState<{ url: string; title: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [adoptedPendingTurn, setAdoptedPendingTurn] = useState<ActiveConversationTurn | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationSearch, setConversationSearch] = useState("");
  const [conversationTransferMessage, setConversationTransferMessage] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [allowedRepositories, setAllowedRepositories] = useState<AllowedRepository[]>([]);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [repositoryMessage, setRepositoryMessage] = useState("");
  const [repositoryPanelOpen, setRepositoryPanelOpen] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState<AllowedRepository | null>(null);
  const [codeQuery, setCodeQuery] = useState("");
  const [codeResults, setCodeResults] = useState<CodeSearchResult[]>([]);
  const [codePreview, setCodePreview] = useState<CodePreview | null>(null);
  const [attachedCodeContext, setAttachedCodeContext] = useState<AttachedCodeContext | null>(null);
  const [codeSearchMessage, setCodeSearchMessage] = useState("");
  const [codeSearching, setCodeSearching] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatus | null>(null);
  const [knowledgeUpdates, setKnowledgeUpdates] = useState<KnowledgeUpdates | null>(null);
  const [knowledgePanelOpen, setKnowledgePanelOpen] = useState(false);
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("discover");
  const [knowledgePeriod, setKnowledgePeriod] = useState<"week" | "month">("week");
  const [readKnowledgeVersion, setReadKnowledgeVersion] = useState<string | null>(null);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [sqlPanelOpen, setSqlPanelOpen] = useState(false);
  const [attachedDataset, setAttachedDataset] = useState<AttachedDataset | null>(null);
  const [sqlDraft, setSqlDraft] = useState<SqlDraft | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnRef = useRef<ActiveConversationTurn | null>(null);
  const sendingRef = useRef(false);
  const conversationLoadingRef = useRef(false);
  const conversationOpenEpochRef = useRef(0);
  const responseFeedbackConversationRef = useRef<string | null>(null);
  const responseFeedbackGenerationRef = useRef(0);
  const responseFeedbackOperationRef = useRef(0);
  const responseFeedbackMutationRevisionsRef = useRef(new Map<string, number>());
  const responseFeedbackReadRequestRef = useRef(0);
  const responseFeedbackLatestAppliedReadRef = useRef(0);
  const followLatestRef = useRef(true);
  const knowledgeCloseRef = useRef<HTMLButtonElement>(null);
  const conversationImportRef = useRef<HTMLInputElement>(null);
  const repositoryCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsPopoverRef = useRef<HTMLDivElement>(null);
  const preferencesTriggerRef = useRef<HTMLButtonElement>(null);
  const bookWelcomeRequestRef = useRef<AbortController | null>(null);
  const wordPreviewCloseRef = useRef<HTMLButtonElement>(null);
  const wordPreviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const closeWordPreview = useCallback(() => {
    setWordPreview(null);
    requestAnimationFrame(() => wordPreviewReturnFocusRef.current?.focus());
  }, []);
  const bindResponseFeedback = useCallback((conversationId: string | null, value: unknown) => {
    responseFeedbackConversationRef.current = conversationId;
    responseFeedbackGenerationRef.current += 1;
    setResponseFeedbackGeneration(responseFeedbackGenerationRef.current);
    responseFeedbackOperationRef.current += 1;
    responseFeedbackMutationRevisionsRef.current.clear();
    responseFeedbackLatestAppliedReadRef.current = ++responseFeedbackReadRequestRef.current;
    setResponseFeedback(conversationId ? responseFeedbackMap(value) : {});
  }, []);
  const applyResponseFeedbackRead = useCallback((
    conversationId: string,
    generation: number,
    requestId: number,
    startedAtRevision: number,
    value: unknown,
  ) => {
    if (!responseFeedbackBindingMatches(
      responseFeedbackConversationRef.current,
      responseFeedbackGenerationRef.current,
      conversationId,
      generation,
    ) || requestId < responseFeedbackLatestAppliedReadRef.current) return;
    responseFeedbackLatestAppliedReadRef.current = requestId;
    const remote = responseFeedbackMap(value);
    setResponseFeedback((current) => mergeResponseFeedbackRead(
      remote,
      current,
      responseFeedbackMutationRevisionsRef.current,
      startedAtRevision,
    ));
  }, []);
  const updateResponseFeedbackForConversation = useCallback((
    conversationId: string,
    generation: number,
    turnId: string,
    rating: ResponseFeedbackRating | null,
  ) => {
    if (!responseFeedbackBindingMatches(
      responseFeedbackConversationRef.current,
      responseFeedbackGenerationRef.current,
      conversationId,
      generation,
    )) return;
    const revision = ++responseFeedbackOperationRef.current;
    responseFeedbackMutationRevisionsRef.current.set(turnId, revision);
    setResponseFeedback((current) => ({ ...current, [turnId]: rating }));
  }, []);
  const abandonActiveTurn = useCallback(async (keepalive = false, retainSending = false) => {
    const controller = abortRef.current;
    controller?.abort();
    if (abortRef.current === controller) abortRef.current = null;
    const activeTurn = activeTurnRef.current;
    if (activeTurnRef.current === activeTurn) activeTurnRef.current = null;
    if (activeTurn) {
      setAdoptedPendingTurn((current) => current?.turnId === activeTurn.turnId ? null : current);
    }
    if (!retainSending) {
      sendingRef.current = false;
      setSending(false);
    }
    return activeTurn ? requestTurnCancellation(activeTurn, keepalive) : true;
  }, []);
  const reconcileTurnFromServer = useCallback(async (conversationId: string, turnId: string, signal?: AbortSignal): Promise<ConversationTurnStatus | null> => {
    const feedbackGeneration = responseFeedbackGenerationRef.current;
    const feedbackRevision = responseFeedbackOperationRef.current;
    const feedbackRequestId = ++responseFeedbackReadRequestRef.current;
    try {
      const response = await localApiFetch(`/api/conversations/${conversationId}`, { cache: "no-store", signal });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        conversation?: { messages?: ChatMessage[] };
        responseFeedback?: unknown;
      };
      if (!Array.isArray(data.conversation?.messages)) return null;
      const receipt = data.conversation.messages.find((message) => message.turn?.id === turnId)?.turn;
      if (!receipt) return null;
      const authoritative = displayMessagesFromTimeline(data.conversation.messages)
        .filter((message) => message.turn?.id === turnId);
      if (!authoritative.length) return null;
      if (!responseFeedbackBindingMatches(
        responseFeedbackConversationRef.current,
        responseFeedbackGenerationRef.current,
        conversationId,
        feedbackGeneration,
      )) return receipt.status;
      setMessages((current) => {
        const firstIndex = current.findIndex((message) => message.turn?.id === turnId);
        if (firstIndex < 0) return current;
        const withoutTurn = current.filter((message) => message.turn?.id !== turnId);
        withoutTurn.splice(firstIndex, 0, ...authoritative);
        return withoutTurn;
      });
      applyResponseFeedbackRead(
        conversationId,
        feedbackGeneration,
        feedbackRequestId,
        feedbackRevision,
        data.responseFeedback,
      );
      return receipt.status;
    } catch {
      // The terminal receipt remains available on the next local reopen.
      return null;
    }
  }, [applyResponseFeedbackRead]);
  const closeMemoryPanel = useCallback(() => setMemoryPanelOpen(false), []);
  const closeSqlPanel = useCallback(() => setSqlPanelOpen(false), []);
  const nextWelcomeIndex = useCallback((current: number, welcomeMode: WelcomeMode) => {
    const storageKey = profileScopedStorageKey(WELCOME_HISTORY_STORAGE_KEY);
    const history = parseWelcomeHistory(localStorage.getItem(storageKey));
    const next = chooseWelcomeIndex(current, history, Math.random, welcomeMode);
    localStorage.setItem(storageKey, JSON.stringify(appendWelcomeHistory(history, next)));
    return next;
  }, []);
  const refreshBookWelcome = useCallback(async () => {
    bookWelcomeRequestRef.current?.abort();
    const controller = new AbortController();
    bookWelcomeRequestRef.current = controller;
    setBookWelcomeLoading(true);
    setBookWelcomeFact(null);
    const recent = parseBookWelcomeHistory();
    const parameters = new URLSearchParams();
    if (recent.length) parameters.set("exclude", recent.join(","));
    try {
      const response = await localApiFetch(`/api/knowledge/welcome${parameters.size ? `?${parameters}` : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const result = (await response.json()) as BookWelcomeResponse;
      if (result.status !== "ready") return;
      setBookWelcomeFact(result.fact);
      localStorage.setItem(profileScopedStorageKey(BOOK_WELCOME_HISTORY_STORAGE_KEY), JSON.stringify([...recent.filter((id) => id !== result.fact.id), result.fact.id].slice(-60)));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setBookWelcomeFact(null);
    } finally {
      if (bookWelcomeRequestRef.current === controller) {
        bookWelcomeRequestRef.current = null;
        setBookWelcomeLoading(false);
      }
    }
  }, []);

  async function refreshStatus() {
    try {
      const response = await localApiFetch("/api/status", { cache: "no-store" });
      setStatus(await response.json());
    } catch {
      setStatus(null);
    }
  }

  async function refreshConversations(query = conversationSearch, projectId = activeProjectId) {
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set("query", query.trim());
    if (projectId) parameters.set("projectId", projectId);
    const response = await localApiFetch(`/api/conversations${parameters.size ? `?${parameters}` : ""}`, { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations);
    }
  }

  async function refreshProjects() {
    const response = await localApiFetch("/api/projects", { cache: "no-store" });
    if (response.ok) setProjects(((await response.json()) as { projects: ProjectSummary[] }).projects);
  }

  async function refreshRepositories() {
    const response = await localApiFetch("/api/repositories", { cache: "no-store" });
    const data = (await response.json()) as { repositories?: AllowedRepository[]; error?: string };
    if (response.ok && data.repositories) setAllowedRepositories(data.repositories);
    else setRepositoryMessage(data.error ?? "Could not read allowed folders.");
  }

  async function allowLocalRepository(event: FormEvent) {
    event.preventDefault();
    const path = repositoryPath.trim();
    if (!path) return;
    const response = await localApiFetch("/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = (await response.json()) as { repository?: AllowedRepository; error?: string };
    if (!response.ok || !data.repository) {
      setRepositoryMessage(data.error ?? "Could not allow this folder.");
      return;
    }
    setRepositoryPath("");
    setRepositoryMessage(`Allowed ${data.repository.path}. No files have been read.`);
    await refreshRepositories();
  }

  async function revokeLocalRepository(repository: AllowedRepository) {
    const response = await localApiFetch(`/api/repositories/${repository.id}`, { method: "DELETE" });
    if (!response.ok) {
      setRepositoryMessage("Could not revoke this folder.");
      return;
    }
    setRepositoryMessage(`Revoked ${repository.path}. The folder was not changed.`);
    if (selectedRepository?.id === repository.id) {
      setRepositoryPanelOpen(false);
      setSelectedRepository(null);
    }
    await refreshRepositories();
  }

  function openRepositorySearch(repository: AllowedRepository) {
    setSelectedRepository(repository);
    setCodeQuery("");
    setCodeResults([]);
    setCodePreview(null);
    setCodeSearchMessage("");
    setRepositoryPanelOpen(true);
  }

  async function searchAllowedRepository(event: FormEvent) {
    event.preventDefault();
    if (!selectedRepository || codeQuery.trim().length < 2) return;
    setCodeSearching(true);
    setCodePreview(null);
    setCodeSearchMessage("");
    const parameters = new URLSearchParams({ query: codeQuery.trim() });
    const response = await localApiFetch(`/api/repositories/${selectedRepository.id}/search?${parameters}`, { cache: "no-store" });
    const data = (await response.json()) as { results?: CodeSearchResult[]; error?: string };
    setCodeSearching(false);
    if (!response.ok || !data.results) {
      setCodeResults([]);
      setCodeSearchMessage(data.error ?? "Code search failed.");
      return;
    }
    setCodeResults(data.results);
    setCodeSearchMessage(data.results.length ? `${data.results.length} local match${data.results.length === 1 ? "" : "es"}.` : "No matches in searchable files.");
  }

  async function openCodePreview(result: CodeSearchResult) {
    if (!selectedRepository) return;
    const parameters = new URLSearchParams({ path: result.path, line: String(result.line) });
    const response = await localApiFetch(`/api/repositories/${selectedRepository.id}/preview?${parameters}`, { cache: "no-store" });
    const data = (await response.json()) as { preview?: CodePreview; error?: string };
    if (response.ok && data.preview) setCodePreview(data.preview);
    else setCodeSearchMessage(data.error ?? "Could not preview this file.");
  }

  function attachCodePreview() {
    if (!selectedRepository || !codePreview) return;
    setAttachedCodeContext({
      repositoryId: selectedRepository.id,
      repositoryName: selectedRepository.name,
      path: codePreview.path,
      line: codePreview.focusLine,
      startLine: codePreview.startLine,
      endLine: codePreview.startLine + codePreview.lines.length - 1,
      characterCount: codePreview.lines.join("\n").length,
    });
    setRepositoryPanelOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  async function refreshKnowledge() {
    const [statusResponse, updatesResponse] = await Promise.all([localApiFetch("/api/knowledge/status", { cache: "no-store" }), localApiFetch("/api/knowledge/updates", { cache: "no-store" })]);
    if (statusResponse.ok) setKnowledgeStatus(await statusResponse.json());
    if (updatesResponse.ok) setKnowledgeUpdates(await updatesResponse.json());
  }

  async function createNewProject(event: FormEvent) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    const response = await localApiFetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!response.ok) return;
    const project = ((await response.json()) as { project: ProjectSummary }).project;
    setProjects((current) => [project, ...current]);
    setActiveProjectId(project.id);
    setNewProjectName("");
    startNewChat(project.id);
  }

  async function renameProject(project: ProjectSummary) {
    const name = window.prompt("Rename project", project.name)?.trim();
    if (!name || name === project.name) return;
    const response = await localApiFetch(`/api/projects/${project.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (response.ok) await refreshProjects();
  }

  async function removeProject(project: ProjectSummary) {
    if (!window.confirm(`Delete “${project.name}”? Its chats will move to All chats.`)) return;
    const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
    if (sendingRef.current && (activeProjectId === project.id || activeConversation?.projectId === project.id)) {
      await abandonActiveTurn();
    }
    const response = await localApiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!response.ok) return;
    if (activeProjectId === project.id) setActiveProjectId(null);
    await Promise.all([refreshProjects(), refreshConversations()]);
  }

  async function openConversation(id: string) {
    const openEpoch = ++conversationOpenEpochRef.current;
    conversationLoadingRef.current = true;
    setConversationLoading(true);
    try {
      if (sendingRef.current) await abandonActiveTurn();
      if (openEpoch !== conversationOpenEpochRef.current) return;
      const response = await localApiFetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (!response.ok || openEpoch !== conversationOpenEpochRef.current) return;
      const data = (await response.json()) as {
        conversation: { messages: ChatMessage[] };
        attachedDataset: AttachedDataset | null;
        responseFeedback?: unknown;
      };
      if (openEpoch !== conversationOpenEpochRef.current) return;
      const displayMessages = displayMessagesFromTimeline(data.conversation.messages);
      const pendingTurn = data.conversation.messages.find((message) => message.turn?.status === "pending")?.turn;
      followLatestRef.current = true;
      setMessages(displayMessages);
      bindResponseFeedback(id, data.responseFeedback);
      setActiveConversationId(id);
      setReplyTo(null);
      if (pendingTurn) {
        const adoptedTurn = { conversationId: id, turnId: pendingTurn.id };
        activeTurnRef.current = adoptedTurn;
        setAdoptedPendingTurn(adoptedTurn);
        sendingRef.current = true;
        setSending(true);
      } else if (!activeTurnRef.current) {
        setAdoptedPendingTurn(null);
        sendingRef.current = false;
        setSending(false);
      }
      setAttachedCodeContext(null);
      setAttachedDataset(data.attachedDataset);
      setSqlDraft(null);
      setSidebarOpen(false);
    } catch {
      // Keep the currently open conversation intact when a local read fails.
    } finally {
      if (openEpoch === conversationOpenEpochRef.current) {
        conversationLoadingRef.current = false;
        setConversationLoading(false);
      }
    }
  }

  async function refreshResponseFeedback(id: string, expectedEpoch = conversationOpenEpochRef.current) {
    const feedbackGeneration = responseFeedbackGenerationRef.current;
    const feedbackRevision = responseFeedbackOperationRef.current;
    const feedbackRequestId = ++responseFeedbackReadRequestRef.current;
    try {
      const response = await localApiFetch(`/api/conversations/${id}/feedback`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { responseFeedback?: unknown };
      if (expectedEpoch !== conversationOpenEpochRef.current) return;
      applyResponseFeedbackRead(id, feedbackGeneration, feedbackRequestId, feedbackRevision, data.responseFeedback);
    } catch {
      // Feedback eligibility is optional UI metadata. Keep the current state if
      // the private local read is temporarily unavailable.
    }
  }

  async function attachDatasetToChat(dataset: AttachedDataset | null) {
    if (!activeConversationId) {
      setAttachedDataset(dataset);
      return;
    }
    const response = await localApiFetch(`/api/conversations/${activeConversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasetId: dataset?.id ?? null }),
    });
    if (response.ok) setAttachedDataset(dataset);
  }

  async function removeConversation(id: string) {
    if (sendingRef.current && activeConversationId === id) await abandonActiveTurn();
    setConversationTransferMessage("");
    try {
      const response = await localApiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: unknown } | null;
        setConversationTransferMessage(typeof data?.error === "string"
          ? `${data.error} Use the delete button to retry.`
          : "The conversation was not deleted. Use the delete button to retry.");
        return;
      }
      if (response.status === 202) {
        const data = await response.json().catch(() => null) as { warning?: unknown } | null;
        setConversationTransferMessage(typeof data?.warning === "string"
          ? data.warning
          : "The conversation was deleted, but private artifact cleanup will retry when Rangabot restarts.");
      }
      if (activeConversationId === id) startNewChat();
      await refreshConversations();
    } catch {
      setConversationTransferMessage("The conversation was not deleted because the local request failed. Use the delete button to retry.");
    }
  }

  async function toggleConversationPin(conversation: ConversationSummary) {
    const response = await localApiFetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !conversation.pinned }),
    });
    if (response.ok) await refreshConversations();
  }

  async function importConversation(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setConversationTransferMessage("Import failed: the file is larger than 2 MB.");
      return;
    }
    const response = await localApiFetch("/api/conversations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: await file.text(), projectId: activeProjectId }),
    });
    const data = (await response.json()) as { conversation?: { id: string }; error?: string };
    if (!response.ok || !data.conversation) {
      setConversationTransferMessage(`Import failed: ${data.error ?? "invalid file"}`);
      return;
    }
    setConversationTransferMessage(`Imported ${file.name} locally.`);
    await refreshConversations();
    await openConversation(data.conversation.id);
  }

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const publicDemo = PUBLIC_DEMO_MODES.has(parameters.get("demo") ?? "");
    setPublicDemo(publicDemo);
    const applyPreferences = (savedWelcomePreferences: WelcomePreferences, savedAppearance: Appearance | null, savedPalette: Palette) => {
      setAppearance(savedAppearance ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
      setPalette(savedPalette);
      setWelcomePreferences(savedWelcomePreferences);
      setWelcomePreferencesReady(true);
      if (savedWelcomePreferences.mode === "books") void refreshBookWelcome();
      else setWelcomeIndex((current) => nextWelcomeIndex(current, savedWelcomePreferences.mode));
    };
    if (publicDemo) {
      applyPreferences({ ...defaultWelcomePreferences }, null, DEFAULT_PALETTE);
    } else {
      void localApiFetch("/api/preferences", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("preferences unavailable");
          const data = await response.json() as { preferences?: DesktopPreferences };
          if (!data.preferences) throw new Error("preferences missing");
          setDesktopPreferencesRevision(data.preferences.revision);
          applyPreferences(
            { version: 1, preferredName: data.preferences.preferredName || null, mode: data.preferences.welcomeMode },
            data.preferences.appearance,
            data.preferences.palette,
          );
          const legacyPreview = data.preferences.revision === 0 && data.preferences.import === null
            ? readSameOriginLegacyPreferencePreview()
            : null;
          setLegacyPreferencesPreview(legacyPreview);
          if (data.preferences.revision === 0 && data.preferences.import === null && !legacyPreview) {
            setPreferencesMessage(
              "Legacy preferences from a different local origin: MISSING. Rangabot does not scan old browser origins; use Preferences to re-enter them manually.",
            );
          }
        })
        .catch(() => {
          applyPreferences({ ...defaultWelcomePreferences }, null, DEFAULT_PALETTE);
          setLegacyPreferencesPreview(null);
          setPreferencesMessage("Desktop preferences could not be loaded safely. No browser preferences were applied.");
        });
    }
    setReadKnowledgeVersion(localStorage.getItem(profileScopedStorageKey("rangabot-knowledge-read")));
    setGreetingIndex((current) => chooseGreetingIndex(current));
    void refreshStatus();
    if (!publicDemo) {
      void refreshProjects();
      void refreshRepositories();
      void refreshKnowledge();
    }
  }, [nextWelcomeIndex, refreshBookWelcome]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarOpen(false);
      requestAnimationFrame(() => mobileNavigationRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => sidebarCloseRef.current?.focus());
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);
  useEffect(() => {
    if (!toolsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setToolsOpen(false);
      requestAnimationFrame(() => toolsTriggerRef.current?.focus());
    };
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (toolsTriggerRef.current?.contains(event.target) || toolsPopoverRef.current?.contains(event.target)) return;
      setToolsOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [toolsOpen]);
  useEffect(() => () => bookWelcomeRequestRef.current?.abort(), []);
  useEffect(() => {
    const cancelOnPageHide = () => {
      if (!sendingRef.current) return;
      void abandonActiveTurn(true);
    };
    window.addEventListener("pagehide", cancelOnPageHide);
    return () => window.removeEventListener("pagehide", cancelOnPageHide);
  }, [abandonActiveTurn]);
  useEffect(() => {
    if (!adoptedPendingTurn) return;
    let disposed = false;
    let attempts = 0;
    let timer: number | null = null;
    const controller = new AbortController();
    const poll = async () => {
      const turnStatus = await reconcileTurnFromServer(
        adoptedPendingTurn.conversationId,
        adoptedPendingTurn.turnId,
        controller.signal,
      );
      if (disposed) return;
      if (turnStatus && turnStatus !== "pending") {
        if (activeTurnRef.current?.turnId === adoptedPendingTurn.turnId) {
          activeTurnRef.current = null;
          sendingRef.current = false;
          setSending(false);
        }
        setAdoptedPendingTurn((current) => current?.turnId === adoptedPendingTurn.turnId ? null : current);
        return;
      }
      attempts += 1;
      if (attempts < ADOPTED_TURN_POLL_ATTEMPTS) {
        timer = window.setTimeout(() => void poll(), ADOPTED_TURN_POLL_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(() => void poll(), ADOPTED_TURN_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [adoptedPendingTurn, reconcileTurnFromServer]);
  useEffect(() => {
    if (PUBLIC_DEMO_MODES.has(new URLSearchParams(window.location.search).get("demo") ?? "")) {
      setConversations([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const parameters = new URLSearchParams();
      if (conversationSearch.trim()) parameters.set("query", conversationSearch.trim());
      if (activeProjectId) parameters.set("projectId", activeProjectId);
      const response = await localApiFetch(`/api/conversations${parameters.size ? `?${parameters}` : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      }).catch(() => null);
      if (response?.ok) {
        const data = (await response.json()) as { conversations: ConversationSummary[] };
        setConversations(data.conversations);
      }
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [conversationSearch, activeProjectId]);
  useEffect(() => {
    if (!knowledgePanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setKnowledgePanelOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => knowledgeCloseRef.current?.focus());
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [knowledgePanelOpen]);
  useEffect(() => {
    if (!repositoryPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRepositoryPanelOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => repositoryCloseRef.current?.focus());
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [repositoryPanelOpen]);
  useEffect(() => {
    if (!knowledgePanelOpen || knowledgeTab !== "discover" || !knowledgeUpdates?.weekUpdatedAt) return;
    localStorage.setItem(profileScopedStorageKey("rangabot-knowledge-read"), knowledgeUpdates.weekUpdatedAt);
    setReadKnowledgeVersion(knowledgeUpdates.weekUpdatedAt);
  }, [knowledgePanelOpen, knowledgeTab, knowledgeUpdates?.weekUpdatedAt]);
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("demo") === "welcome") {
      setAppearance(parameters.get("theme") === "dark" ? "dark" : "light");
      setPalette("rangabot");
      setMessages([]);
      return;
    }
    if (parameters.get("demo") !== "knowledge") return;
    setAppearance(parameters.get("theme") === "light" ? "light" : "dark");
    setPalette("moss");
    const question: DisplayMessage = {
      id: "demo-question",
      role: "user",
      content: "What changed in NumPy 2.5 for local data science work?",
    };
    const step = parameters.get("step") ?? "answer";
    if (step === "question") {
      setMessages([question]);
      return;
    }
    if (step === "thinking") {
      setMessages([question, { id: "demo-thinking", role: "assistant", content: "", source: "local", active: true, knowledgeUsed: true }]);
      return;
    }
    setMessages([question, {
      id: "demo-answer",
      role: "assistant",
      source: "local",
      knowledgeUsed: true,
      content: "NumPy 2.5 raises the Python baseline to 3.12+, removes distutils, improves free-threading support, and adds Array API-compatible descending sorts. For an upgrade, test packaging and sorting behavior against your real workloads. [Source 1]",
    }]);
  }, []);
  useEffect(() => {
    if (messages.length > 0 && followLatestRef.current) endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || profileSwitching || sendingRef.current || conversationLoadingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setAdoptedPendingTurn(null);
    const sendEpoch = conversationOpenEpochRef.current;

    const reference = replyTo ? {
      role: replyTo.role as "user" | "assistant",
      excerpt: replyTo.content.slice(0, 160),
    } : undefined;
    const codeContextForRequest = attachedCodeContext;
    const codeContext = codeContextForRequest ? {
      repository: codeContextForRequest.repositoryName,
      path: codeContextForRequest.path,
      startLine: codeContextForRequest.startLine,
      endLine: codeContextForRequest.endLine,
    } : undefined;
    const turnId = crypto.randomUUID();
    const pendingTurn = { id: turnId, status: "pending" as const };
    const turnMessage: ChatMessage = { role: "user", content, ...(reference ? { replyTo: reference } : {}), ...(codeContext ? { codeContext } : {}) };
    const userMessage: DisplayMessage = { ...turnMessage, id: `${turnId}:user`, turn: pendingTurn };
    const assistantId = `${turnId}:assistant`;
    const assistantMessage: DisplayMessage = { id: assistantId, role: "assistant", content: "", source: "local", active: true, turn: pendingTurn };
    let conversationId = activeConversationId;
    const abortController = new AbortController();
    abortRef.current = abortController;
    let turnStarted = false;
    let responseFailureCode: string | undefined;
    let responseArtifactIntent: ChatMessage["artifactIntent"];
    let responseWordArtifact: ChatMessage["wordArtifact"];
    let responseMemoryUse: ChatMessage["memoryUse"];
    let responseMemoryTitles: ChatMessage["memoryTitles"];
    let responseAnalysisTrace: ChatMessage["analysisTrace"];
    let responseAnswerDisposition: ChatMessage["answerDisposition"];
    let responsePackWarnings: ChatMessage["packWarnings"];

    // Release the composer immediately. A failed start restores only fields the
    // user has not already replaced while the idempotent request was in flight.
    setInput("");
    setReplyTo(null);
    setAttachedCodeContext(null);

    try {
      const startPayload = JSON.stringify({
          protocolVersion: CONVERSATION_TURN_PROTOCOL_VERSION,
          turnId,
          ...(conversationId
            ? { conversationId }
            : {
                projectId: activeProjectId,
                ...(attachedDataset ? { datasetId: attachedDataset.id } : {}),
              }),
          message: turnMessage,
          options: {
            mode,
            ...(codeContextForRequest ? { codeContext: { repositoryId: codeContextForRequest.repositoryId, path: codeContextForRequest.path, line: codeContextForRequest.line } } : {}),
          },
      });
      const startData = await startConversationTurn(startPayload, turnId, abortController.signal);
      if (!startData.ok || !startData.conversationId) {
        responseFailureCode = startData.code;
        throw new Error(startData.error ?? "The local turn could not be started.");
      }
      conversationId = startData.conversationId;
      turnStarted = true;
      activeTurnRef.current = { conversationId, turnId };
      if (abortController.signal.aborted) {
        await requestTurnCancellation({ conversationId, turnId });
        throw abortController.signal.reason ?? new DOMException("Stopped", "AbortError");
      }
      followLatestRef.current = true;
      if (responseFeedbackConversationRef.current !== conversationId) bindResponseFeedback(conversationId, []);
      setActiveConversationId(conversationId);
      setMessages((current) => [...current, userMessage, assistantMessage]);
      void refreshConversations();
      const response = await localApiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          protocolVersion: CONVERSATION_TURN_PROTOCOL_VERSION,
          conversationId,
          turnId,
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: unknown; code?: unknown };
        if (typeof data.code === "string") responseFailureCode = data.code;
        throw new Error(typeof data.error === "string" ? data.error : "Request failed");
      }
      if (!response.body) throw new Error("The local model returned no response stream.");
      responseArtifactIntent = response.headers.get("X-Rangabot-Artifact-Intent") === "word" ? "word" : undefined;
      const encodedArtifact = response.headers.get("X-Rangabot-Word-Artifact");
      if (encodedArtifact) {
        try {
          responseWordArtifact = JSON.parse(decodeURIComponent(encodedArtifact)) as ChatMessage["wordArtifact"];
        } catch {
          responseWordArtifact = undefined;
        }
      }
      const encodedAnalysis = response.headers.get("X-Rangabot-Analysis");
      if (encodedAnalysis) {
        responseAnalysisTrace = parseAnalysisTraceHeader(encodedAnalysis) ?? undefined;
      }
      responsePackWarnings = parsePackWarningCodesHeader(response.headers.get("X-Rangabot-Pack-Warnings")) ?? undefined;
      responseAnswerDisposition = responsePackWarnings?.length ? "verified-fallback" : undefined;
      if (!responseAnalysisTrace?.packId) responseAnswerDisposition = undefined;
      if (responseAnalysisTrace) {
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, analysisTrace: responseAnalysisTrace, ...(responseAnswerDisposition ? { answerDisposition: responseAnswerDisposition, packWarnings: responsePackWarnings } : {}) }
          : message));
      }
      if (responseArtifactIntent || responseWordArtifact) {
        setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, artifactIntent: responseArtifactIntent, wordArtifact: responseWordArtifact } : message));
      }
      const knowledgeUsed = response.headers.get("X-Rangabot-Knowledge") === "used";
      const retrievalHeader = response.headers.get("X-Rangabot-Retrieval");
      const retrievalMode = retrievalHeader === "hybrid" || retrievalHeader === "keyword-only" ? retrievalHeader : undefined;
      const memoryHeader = response.headers.get("X-Rangabot-Memory");
      responseMemoryUse = memoryHeader === "direct" ? "direct" : memoryHeader === "used" ? "context" : undefined;
      const encodedMemoryTitles = response.headers.get("X-Rangabot-Memory-Titles");
      if (encodedMemoryTitles) {
        try {
          const parsed = JSON.parse(decodeURIComponent(encodedMemoryTitles));
          if (Array.isArray(parsed) && parsed.every((title) => typeof title === "string")) responseMemoryTitles = parsed.slice(0, 8);
        } catch {
          responseMemoryTitles = undefined;
        }
      }
      if (knowledgeUsed) {
        setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, knowledgeUsed: true, retrievalMode } : message));
      }
      if (responseMemoryUse) {
        setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, memoryUse: responseMemoryUse, memoryTitles: responseMemoryTitles } : message));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let receivedContent = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        receivedContent = true;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content + chunk, active: true } : message
        )));
      }
      const finalChunk = decoder.decode();
      if (finalChunk) {
        receivedContent = true;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content + finalChunk, active: true } : message
        )));
      }
      if (!receivedContent) throw new Error("The local model returned an empty response.");
      setMessages((current) => current.map((message) => message.turn?.id === turnId
        ? { ...message, active: false, turn: { id: turnId, status: "completed" } }
        : message));
      if (conversationId) await refreshResponseFeedback(conversationId, sendEpoch);
    } catch (error) {
      const stopped = abortController.signal.aborted;
      if (turnStarted) {
        const cancellationConfirmed = stopped && conversationId
          ? await requestTurnCancellation({ conversationId, turnId })
          : true;
        const terminalStatus = stopped ? "cancelled" as const : "failed" as const;
        const failureMessage = error instanceof Error ? error.message : "The request failed.";
        setMessages((current) => current.map((message) => {
          if (message.turn?.id !== turnId) return message;
          const turn = { id: turnId, status: terminalStatus, ...(!stopped && responseFailureCode ? { failureCode: responseFailureCode } : {}) };
          if (message.id !== assistantId) return { ...message, turn };
          return stopped
            ? { ...message, content: message.content || "No response was generated.", active: false, stopped: true, turn }
            : { ...message, content: message.content || failureMessage, error: true, source: undefined, active: false, turn };
        }));
        const authoritativeStatus = conversationId
          ? await reconcileTurnFromServer(conversationId, turnId)
          : null;
        const shouldRetainOwnership = authoritativeStatus === "pending"
          || (authoritativeStatus === null && (!stopped || !cancellationConfirmed));
        const newerTurnOwnsComposer = activeTurnRef.current && activeTurnRef.current.turnId !== turnId;
        if (conversationId && shouldRetainOwnership && !newerTurnOwnsComposer
          && sendEpoch === conversationOpenEpochRef.current && !conversationLoadingRef.current) {
          if (abortRef.current === abortController) abortRef.current = null;
          const retainedTurn = { conversationId, turnId };
          activeTurnRef.current = retainedTurn;
          setAdoptedPendingTurn(retainedTurn);
          sendingRef.current = true;
          setSending(true);
          if (authoritativeStatus === null) {
            setMessages((current) => current.map((message) => message.turn?.id === turnId
              ? { ...message, active: message.role === "assistant", stopped: false, error: false, turn: { id: turnId, status: "pending" } }
              : message));
          }
        }
      } else if (!stopped) {
        if (responseFailureCode === "not-found") {
          bindResponseFeedback(null, []);
          setActiveConversationId(null);
          setAttachedDataset(null);
        }
        setInput((current) => current || content);
        if (replyTo) setReplyTo((current) => current ?? replyTo);
        if (codeContextForRequest) setAttachedCodeContext((current) => current ?? codeContextForRequest);
        setMessages((current) => [...current,
          { ...userMessage, turn: undefined },
          { ...assistantMessage, turn: undefined, active: false, error: true, source: undefined, content: error instanceof Error ? error.message : "The request failed." },
        ]);
      }
      if (!stopped) void refreshStatus();
    } finally {
      const ownsSendingSlot = abortRef.current === abortController;
      if (ownsSendingSlot) {
        sendingRef.current = false;
        setSending(false);
        abortRef.current = null;
        if (activeTurnRef.current?.turnId === turnId) activeTurnRef.current = null;
      }
      if (turnStarted) void refreshConversations();
    }
  }

  async function stopGenerating() {
    const activeTurn = activeTurnRef.current;
    const stopEpoch = conversationOpenEpochRef.current;
    const cancellationConfirmed = await abandonActiveTurn(false, true);
    if (!activeTurn) {
      sendingRef.current = false;
      setSending(false);
      return;
    }
    const authoritativeStatus = await reconcileTurnFromServer(activeTurn.conversationId, activeTurn.turnId);
    const shouldRetainOwnership = authoritativeStatus === "pending"
      || (!cancellationConfirmed && authoritativeStatus === null);
    const newerTurnOwnsComposer = activeTurnRef.current && activeTurnRef.current.turnId !== activeTurn.turnId;
    if (shouldRetainOwnership && !newerTurnOwnsComposer
      && stopEpoch === conversationOpenEpochRef.current && !conversationLoadingRef.current) {
      activeTurnRef.current = activeTurn;
      setAdoptedPendingTurn(activeTurn);
      sendingRef.current = true;
      setSending(true);
      if (authoritativeStatus === null) {
        setMessages((current) => current.map((message) => message.turn?.id === activeTurn.turnId
          ? { ...message, active: message.role === "assistant", stopped: false, error: false, turn: { id: activeTurn.turnId, status: "pending" } }
          : message));
      }
      return;
    }
    if (!newerTurnOwnsComposer && stopEpoch === conversationOpenEpochRef.current) {
      sendingRef.current = false;
      setSending(false);
      setAdoptedPendingTurn(null);
      if (cancellationConfirmed && authoritativeStatus === null) {
        setMessages((current) => current.map((message) => message.turn?.id === activeTurn.turnId
          ? { ...message, active: false, stopped: message.role === "assistant", turn: { id: activeTurn.turnId, status: "cancelled" } }
          : message));
      }
    }
  }

  function startNewChat(projectId: string | null = activeProjectId) {
    conversationOpenEpochRef.current += 1;
    conversationLoadingRef.current = false;
    setConversationLoading(false);
    if (sendingRef.current) void abandonActiveTurn();
    bookWelcomeRequestRef.current?.abort();
    setAdoptedPendingTurn(null);
    followLatestRef.current = true;
    setMessages([]);
    bindResponseFeedback(null, []);
    setActiveConversationId(null);
    setActiveProjectId(projectId);
    setInput("");
    setReplyTo(null);
    setAttachedCodeContext(null);
    setAttachedDataset(null);
    setSidebarOpen(false);
    rotateWelcome(welcomePreferences.mode);
  }

  function copyTurnRequestText(turnId: string) {
    const request = messages.find((message) => message.turn?.id === turnId && message.role === "user");
    if (!request) return;
    setInput(request.content);
    setReplyTo(null);
    setAttachedCodeContext(null);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  function rotateWelcome(mode: WelcomeMode) {
    setGreetingIndex((current) => chooseGreetingIndex(current));
    if (mode === "books") {
      void refreshBookWelcome();
      return;
    }
    bookWelcomeRequestRef.current?.abort();
    setBookWelcomeLoading(false);
    setBookWelcomeFact(null);
    setWelcomeIndex((current) => nextWelcomeIndex(current, mode));
  }

  function closeWelcomePreferences() {
    setWelcomePreferencesOpen(false);
    requestAnimationFrame(() => preferencesTriggerRef.current?.focus());
  }

  async function saveWelcomePreferences(preferences: WelcomePreferences, nextAppearance: Appearance, nextPalette: Palette) {
    const previous = { preferences: welcomePreferences, appearance, palette };
    let rollback = previous;
    setWelcomePreferences(preferences);
    setAppearance(nextAppearance);
    setPalette(nextPalette);
    setPreferencesMessage("");
    try {
      const response = await localApiFetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: desktopPreferencesRevision,
          preferredName: preferences.preferredName ?? "",
          welcomeMode: preferences.mode,
          appearance: nextAppearance,
          palette: nextPalette,
        }),
      });
      const data = await response.json() as { preferences?: DesktopPreferences; error?: string };
      if (!response.ok || !data.preferences) {
        if (response.status === 409 && data.preferences) {
          rollback = {
            preferences: {
              version: 1,
              preferredName: data.preferences.preferredName || null,
              mode: data.preferences.welcomeMode,
            },
            appearance: data.preferences.appearance ?? previous.appearance,
            palette: data.preferences.palette,
          };
          setDesktopPreferencesRevision(data.preferences.revision);
        }
        throw new Error(data.error ?? "save failed");
      }
      setDesktopPreferencesRevision(data.preferences.revision);
      setLegacyPreferencesPreview(null);
      setPreferencesMessage("Preferences saved locally.");
      setWelcomePreferencesOpen(false);
      rotateWelcome(preferences.mode);
    } catch {
      setWelcomePreferences(rollback.preferences);
      setAppearance(rollback.appearance);
      setPalette(rollback.palette);
      setPreferencesMessage("Couldn’t save preferences on this device. Try again.");
    }
    requestAnimationFrame(() => preferencesTriggerRef.current?.focus());
  }

  async function importLegacyPreferences() {
    const preview = legacyPreferencesPreview;
    if (!preview) return;
    const nameSummary = preview.preferredName ? `Name: ${preview.preferredName}\n` : "Name: not set\n";
    const appearanceSummary = preview.appearance ?? "system default";
    const confirmed = window.confirm(
      `Import this legacy same-origin preference preview?\n\n${nameSummary}Welcome: ${preview.welcomeMode}\nAppearance: ${appearanceSummary}\nPalette: ${preview.palette}\n\nExisting desktop preferences always win.`,
    );
    if (!confirmed) return;
    setPreferencesMessage("");
    try {
      const response = await localApiFetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          expectedRevision: desktopPreferencesRevision,
          ...preview,
        }),
      });
      const data = await response.json() as {
        kind?: "imported" | "existing-wins";
        preferences?: DesktopPreferences;
        error?: string;
      };
      if (!response.ok || !data.preferences || !data.kind) throw new Error(data.error ?? "import failed");
      const saved = data.preferences;
      setDesktopPreferencesRevision(saved.revision);
      setWelcomePreferences({ version: 1, preferredName: saved.preferredName || null, mode: saved.welcomeMode });
      setAppearance(saved.appearance ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
      setPalette(saved.palette);
      setLegacyPreferencesPreview(null);
      setPreferencesMessage(data.kind === "imported" ? "Legacy preferences imported locally." : "Existing desktop preferences kept.");
      rotateWelcome(saved.welcomeMode);
    } catch {
      setPreferencesMessage("Legacy preferences were not imported. Your existing desktop preferences were not changed.");
    }
  }

  function chooseStarter(prompt: string) {
    if (profileSwitching) return;
    setInput(prompt);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  async function exportOpenConversation() {
    if (!activeConversationId || profileSwitching) return;
    setConversationTransferMessage("Preparing the open chat locally…");
    try {
      await downloadLocalApiFile(`/api/conversations/${activeConversationId}/export`, "rangabot-conversation.md");
      setConversationTransferMessage("Open chat export ready.");
    } catch (error) {
      setConversationTransferMessage(error instanceof Error ? error.message : "The open chat could not be exported.");
    }
  }

  async function downloadWordArtifact(id: string, filename: string) {
    try {
      await downloadLocalApiFile(`/api/artifacts/word/${id}/document`, filename);
    } catch (error) {
      setConversationTransferMessage(error instanceof Error ? error.message : "The document could not be downloaded.");
    }
  }

  async function reviewWordArtifact(id: string, title: string) {
    try {
      const blob = await localApiBlob(`/api/artifacts/word/${id}/preview/1`);
      wordPreviewReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setWordPreview({ url: URL.createObjectURL(blob), title });
    } catch (error) {
      setConversationTransferMessage(error instanceof Error ? error.message : "The document preview could not be opened.");
    }
  }

  useEffect(() => {
    if (!wordPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeWordPreview(); };
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => wordPreviewCloseRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      URL.revokeObjectURL(wordPreview.url);
    };
  }, [closeWordPreview, wordPreview]);

  const ready = status?.available && status.modelInstalled;
  const profileWorkspaceBlocked = profileSwitching || profileRecoveryRequired;
  const visibleConversations = conversations;
  const weeklyBrief = useMemo(() => parseKnowledgeBrief(knowledgeUpdates?.week ?? ""), [knowledgeUpdates?.week]);
  const unreadKnowledge = knowledgeUpdates?.weekUpdatedAt && knowledgeUpdates.weekUpdatedAt !== readKnowledgeVersion
    ? weeklyBrief.length
    : 0;
  const welcomeLine = welcomeLines[welcomeIndex] ?? welcomeLines[0];
  const routeDescription = mode === "codex"
    ? "Cloud handoff is not enabled"
    : mode === "teach"
      ? "Strict local-vault teaching with citations"
      : mode === "smart"
        ? "Automatically uses relevant local knowledge"
        : "Stays on this computer";
  const bookWelcomeCitation = bookWelcomeFact
    ? [
        bookWelcomeFact.source.title,
        bookWelcomeFact.source.heading,
        bookWelcomeFact.source.pageStart
          ? `page ${bookWelcomeFact.source.pageStart}${bookWelcomeFact.source.pageEnd && bookWelcomeFact.source.pageEnd !== bookWelcomeFact.source.pageStart ? `–${bookWelcomeFact.source.pageEnd}` : ""}`
          : null,
      ].filter(Boolean).join(" · ")
    : "";

  function openKnowledgeBrief(tab: KnowledgeTab = "discover") {
    setKnowledgeTab(tab);
    setKnowledgePanelOpen(true);
  }

  function askAboutUpdate(title: string) {
    setInput(`Teach me about this update and why it matters: ${title}`);
    setKnowledgePanelOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  function followCursor(event: React.PointerEvent<HTMLElement>) {
    const x = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth - .5) * 2));
    const y = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight - .5) * 2));
    event.currentTarget.style.setProperty("--look-x", x.toFixed(2));
    event.currentTarget.style.setProperty("--look-y", y.toFixed(2));
  }

  return (
    <main className="app-shell" data-appearance={appearance} data-palette={palette} onPointerMove={followCursor}>
      <aside id="chat-navigation" className={`sidebar ${sidebarOpen ? "open" : ""}`} inert={profileWorkspaceBlocked}>
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><span>Rangabot</span><button ref={sidebarCloseRef} className="sidebar-close" type="button" onClick={() => { setSidebarOpen(false); requestAnimationFrame(() => mobileNavigationRef.current?.focus()); }} aria-label="Close chat navigation"><CraftIcon name="close" /></button></div>
        <button className="new-chat" onClick={() => startNewChat()}><CraftIcon name="add" /> New chat</button>
        <section className="projects" aria-label="Projects">
          <div className="project-heading"><span>Projects</span><span>{projects.length}</span></div>
          <button type="button" className={`project-row ${activeProjectId === null ? "active" : ""}`} onClick={() => { setActiveProjectId(null); startNewChat(null); }}><CraftIcon name="chat" /> All chats</button>
          {projects.map((project) => <div className={`project-item ${activeProjectId === project.id ? "active" : ""}`} key={project.id}>
            <button type="button" className="project-row" onClick={() => { setActiveProjectId(project.id); startNewChat(project.id); }}><CraftIcon name="folder" />{project.name}</button>
            <button type="button" className="project-more" onClick={() => void renameProject(project)} aria-label={`Rename ${project.name}`}><CraftIcon name="edit" size={14} /></button>
            <button type="button" className="project-more" onClick={() => void removeProject(project)} aria-label={`Delete ${project.name}`}><CraftIcon name="trash" size={14} /></button>
          </div>)}
          <form className="project-create" onSubmit={createNewProject}><input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="New project" maxLength={60} aria-label="New project name" /><button type="submit" disabled={!newProjectName.trim()} aria-label="Create project"><CraftIcon name="add" /></button></form>
        </section>
        <label className="conversation-search">
          <CraftIcon name="search" size={15} />
          <input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="Search chats" aria-label="Search conversations" maxLength={120} />
          {conversationSearch && <button type="button" onClick={() => setConversationSearch("")} aria-label="Clear conversation search"><CraftIcon name="close" size={13} /></button>}
        </label>
        <div className="conversation-tools">
          <button type="button" onClick={() => conversationImportRef.current?.click()}>Import .md</button>
          {activeConversationId
            ? <button type="button" onClick={() => void exportOpenConversation()} disabled={profileSwitching}>Export open chat</button>
            : <span aria-disabled="true">Export open chat</span>}
          <input ref={conversationImportRef} type="file" accept=".md,text/markdown,text/plain" onChange={(event) => void importConversation(event)} />
        </div>
        {conversationTransferMessage && <p className="conversation-transfer-status" role="status">{conversationTransferMessage}</p>}
        {preferencesMessage && <p className="conversation-transfer-status" role="status" aria-live="polite">{preferencesMessage}</p>}
        {legacyPreferencesPreview && (
          <button type="button" className="utility-button" onClick={() => void importLegacyPreferences()}>
            Review legacy preferences
          </button>
        )}
        <nav className="history">
          <span className="nav-label">{conversationSearch ? "Search results" : activeProjectId ? "Project chats" : "Recent chats"}</span>
          {visibleConversations.length === 0 && <p className="history-empty">{conversationSearch ? "No local conversations match this search." : "Your local conversations will appear here."}</p>}
          {visibleConversations.map((conversation) => (
            <div className={`history-row ${conversation.id === activeConversationId ? "active" : ""} ${conversation.pinned ? "pinned" : ""}`} key={conversation.id}>
              <button type="button" onClick={() => void openConversation(conversation.id)}>{conversation.title}</button>
              <button type="button" className="pin-chat" onClick={() => void toggleConversationPin(conversation)} aria-label={`${conversation.pinned ? "Unpin" : "Pin"} ${conversation.title}`} aria-pressed={conversation.pinned}><CraftIcon name="pin" size={13} /></button>
              <button type="button" className="delete-chat" onClick={() => void removeConversation(conversation.id)} aria-label={`Delete ${conversation.title}`}><CraftIcon name="trash" size={13} /></button>
            </div>
          ))}
        </nav>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" type="button" onClick={() => setSidebarOpen(false)} aria-label="Dismiss chat navigation" />}

      <section className={`chat-panel ${messages.length === 0 ? "fresh-chat" : ""}`} inert={sidebarOpen}>
        <header className="chat-header">
          <div className="chat-identity">
            <button ref={mobileNavigationRef} className="mobile-navigation" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open chats and projects" aria-controls="chat-navigation" aria-expanded={sidebarOpen} disabled={profileWorkspaceBlocked}><CraftIcon name="menu" /></button>
            <div><h1>Rangabot</h1><p>Code, think, and build privately</p></div>
          </div>
          <div className="header-actions">
            {!publicDemo && <ProfileManager onSwitchingChange={setProfileSwitching} onActiveProfileChange={setActiveProfileContext} onRecoveryRequiredChange={setProfileRecoveryRequired} />}
            <div className="profile-gated-header-actions" inert={profileWorkspaceBlocked}>
            <button type="button" className="utility-button brief-button" onClick={() => openKnowledgeBrief()} aria-label={`Open Knowledge Brief${unreadKnowledge ? `, ${unreadKnowledge} new items` : ""}`}>
              <CraftIcon name="knowledge" size={15} /><span>Brief</span>{unreadKnowledge > 0 && <b>{unreadKnowledge}</b>}
            </button>
            <button ref={preferencesTriggerRef} type="button" className="utility-button preferences-button" onClick={() => { setToolsOpen(false); setWelcomePreferencesOpen(true); }} aria-label="Open Preferences">
              <CraftIcon name="settings" size={15} /><span>Preferences</span>
            </button>
            <div className="tools-menu">
              <button ref={toolsTriggerRef} type="button" className="utility-button" onClick={() => setToolsOpen((open) => !open)} aria-label="Open Tools" aria-expanded={toolsOpen} aria-controls="rangabot-tools"><CraftIcon name="tune" size={15} /><span>Tools</span></button>
              {toolsOpen && <div ref={toolsPopoverRef} id="rangabot-tools" className="tools-popover" role="region" aria-label="Rangabot tools">
                <div className="tools-popover-heading"><div><strong>Local workbench</strong><small>Choose what Rangabot may use</small></div><span className="privacy-indicator"><CraftIcon name="shield" size={14} /> Local</span></div>
                <nav className="tools-grid" aria-label="Workbench tools">
                  <button type="button" onClick={() => { setMemoryPanelOpen(true); setToolsOpen(false); }}><CraftIcon name="memory" /><span><strong>Memory</strong><small>Review saved facts</small></span></button>
                  <button type="button" onClick={() => { setSqlPanelOpen(true); setToolsOpen(false); }}><CraftIcon name="analysis" /><span><strong>Analyze</strong><small>Use approved local data</small></span></button>
                  <a href="/mastery"><CraftIcon name="mastery" /><span><strong>Mastery</strong><small>Evidence-backed roadmap</small></span></a>
                </nav>
                <section className="tools-folders" aria-label="Allowed local folders">
                  <div className="tools-section-heading"><span><CraftIcon name="folder" size={15} /> Local folders</span><small>{allowedRepositories.length} allowed</small></div>
                  <div className="repository-popover-list">
                    {allowedRepositories.map((repository) => <div className="repository-item" key={repository.id} title={repository.path}>
                      <button type="button" className="repository-open" onClick={() => { openRepositorySearch(repository); setToolsOpen(false); }} aria-label={`Search ${repository.name}`}><CraftIcon name="search" /><span><strong>{repository.name}</strong><small>{repository.path}</small></span></button>
                      <button type="button" onClick={() => void revokeLocalRepository(repository)} aria-label={`Revoke ${repository.name}`}><CraftIcon name="close" size={14} /></button>
                    </div>)}
                    {!allowedRepositories.length && <p>No folders allowed yet.</p>}
                  </div>
                  <form className="repository-create" onSubmit={allowLocalRepository}>
                    <input value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="/absolute/path/to/project" aria-label="Repository folder path" maxLength={1024} />
                    <button type="submit" disabled={!repositoryPath.trim()}>Allow</button>
                  </form>
                  <p className="repository-disclosure">Approval is stored locally. Files are read only after you choose a folder and search it.</p>
                  {repositoryMessage && <p className="repository-status" role="status">{repositoryMessage}</p>}
                </section>
              </div>}
            </div>
            <button className={`status ${ready ? "ready" : "offline"}`} onClick={() => setModelManagerOpen(true)} title="Open Model Manager">
              <span /> {ready ? `${status.configuredModel} ready` : status?.available ? "Model not installed" : "Ollama offline"}
            </button>
            </div>
          </div>
        </header>

        {profileRecoveryRequired && <section className="profile-workspace-blocked" role="alert" aria-live="assertive"><strong>Profile Recovery required</strong><span>Normal workspace access is paused. Open Profiles and recover the last validated local state before continuing.</span></section>}

        <div
          className="messages"
          inert={profileWorkspaceBlocked}
          onScroll={(event) => {
            const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
            followLatestRef.current = isNearMessageBottom(scrollTop, clientHeight, scrollHeight);
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) followLatestRef.current = false;
          }}
        >
          {messages.length === 0 && (
            <section className="welcome-state" aria-labelledby="welcome-title" aria-busy={!welcomePreferencesReady}>
              <div className="welcome-intro">
                <div className="ranga-scene" aria-hidden="true"><div className="welcome-orbit" /></div>
                <div className="welcome-heading">
                  {welcomePreferencesReady ? <div className="welcome-greeting-line">
                    <h2 id="welcome-title">{formatWelcomeGreeting(greetingIndex, welcomePreferences.preferredName ?? "")}</h2>
                  </div> : <div className="welcome-loading" role="status">Preparing your private workspace…</div>}
                </div>
              </div>
              {welcomePreferencesReady && (
                <div className={`welcome-note ${welcomePreferences.mode === "books" ? "book-fact" : ""}`} aria-live="polite">
                  {welcomePreferences.mode === "books" ? (
                    bookWelcomeLoading ? <p className="welcome-note-loading">Choosing a cited sentence from your local books…</p>
                      : bookWelcomeFact ? <><blockquote>{bookWelcomeFact.text}</blockquote><cite>{bookWelcomeCitation}</cite></>
                        : <div className="welcome-book-empty"><strong>No suitable book fact is indexed yet.</strong><span>Add a compatible text-based document to the Knowledge Vault, then ingest it locally.</span></div>
                  ) : <><blockquote>{welcomeLine.kind === "QUOTE" ? `“${welcomeLine.text}”` : welcomeLine.text}</blockquote><cite>{welcomeLine.kind === "QUOTE" ? `— ${welcomeLine.credit}` : welcomeLine.credit}</cite></>}
                </div>
              )}
              <div className="starter-grid" aria-label="Conversation starters">
                <button type="button" onClick={() => chooseStarter("Help me think through an idea: ")} aria-label="Explore an idea locally" title="Brainstorm an idea locally">
                  <span className="starter-icon idea"><CraftIcon name="spark" /></span>
                  <strong>Explore an idea</strong>
                </button>
                <button type="button" onClick={() => chooseStarter("Help me with this coding task: ")} aria-label="Build something with local coding help" title="Plan or improve code locally">
                  <span className="starter-icon code"><CraftIcon name="code" /></span>
                  <strong>Build something</strong>
                </button>
                <button type="button" onClick={() => chooseStarter("Help me write this email. Ask me for the audience, purpose, tone, and key details before drafting: ")} aria-label="Write an email locally" title="Draft an email in the right tone">
                  <span className="starter-icon mail"><CraftIcon name="mail" /></span>
                  <strong>Write an email</strong>
                </button>
                <button type="button" onClick={() => chooseStarter("I want to create a professional Word document. Please ask me what you need before creating it: ")} aria-label="Create a Word document locally" title="Create and preview a Word document">
                  <span className="starter-icon document"><CraftIcon name="document" /></span>
                  <strong>Create a document</strong>
                </button>
              </div>
            </section>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""} ${message.active ? "thinking" : ""}`}>
              {message.role === "assistant" && <div className={`avatar ${message.active ? "active" : ""}`} aria-hidden="true" />}
              <div className="message-body">
                {message.replyTo && <div className="reply-reference"><strong>{message.replyTo.role === "assistant" ? "Rangabot" : "You"}</strong><span>{message.replyTo.excerpt}</span></div>}
                {message.codeContext && <div className="message-code-reference"><strong>Attached code</strong><span>{message.codeContext.repository} · {message.codeContext.path} · lines {message.codeContext.startLine}–{message.codeContext.endLine}</span></div>}
                {message.wordArtifact && <div className="chat-word-artifact"><span><CraftIcon name="document" /></span><div><strong>{message.wordArtifact.title}</strong><small>{message.wordArtifact.filename} · {message.wordArtifact.previewPages} rendered page{message.wordArtifact.previewPages === 1 ? "" : "s"}</small><nav><button type="button" onClick={() => void downloadWordArtifact(message.wordArtifact!.id, message.wordArtifact!.filename)}>Download .docx</button>{message.wordArtifact.previewPages > 0 && <button type="button" onClick={() => void reviewWordArtifact(message.wordArtifact!.id, message.wordArtifact!.title)}>Review preview</button>}</nav></div></div>}
                {message.source && <span className="source">{formatAnswerReceipt(message)}</span>}
                {message.content && (message.role === "assistant"
                  ? <MarkdownMessage content={message.content} />
                  : <p>{message.content}</p>)}
                {message.answerDisposition === "verified-fallback" && <div className="answer-disposition" role="status"><CraftIcon name="shield" size={13} /><span><strong>Verified result fallback</strong>Rangabot answered directly from the checked local calculation.</span></div>}
                {message.analysisTrace && <details className="analysis-trace"><summary><CraftIcon name="analysis" size={14} />How this was calculated</summary><div><span><strong>{message.analysisTrace.dataset}</strong>{message.analysisTrace.returnedRows} verified row{message.analysisTrace.returnedRows === 1 ? "" : "s"} · {message.analysisTrace.durationMs} ms{message.analysisTrace.truncated ? " · bounded result" : ""}</span><pre><code>{message.analysisTrace.query}</code></pre><small>Input {message.analysisTrace.inputSha256.slice(0, 12)}… · Query {message.analysisTrace.querySha256.slice(0, 12)}… · local DuckDB{message.analysisTrace.packId ? ` · ${message.analysisTrace.packId} pack ${message.analysisTrace.packVersion ?? ""}` : ""}{message.analysisTrace.modelId ? ` · ${message.analysisTrace.modelMode ?? "general"} model ${message.analysisTrace.modelId}` : ""}</small></div></details>}
                {message.role === "assistant" && message.turn?.status === "completed"
                  && activeConversationId && !publicDemo
                  && Object.prototype.hasOwnProperty.call(responseFeedback, message.turn.id)
                  && <ResponseFeedback
                    conversationId={activeConversationId}
                    turnId={message.turn.id}
                    rating={responseFeedback[message.turn.id]}
                    onRatingChange={(turnId, rating) => updateResponseFeedbackForConversation(
                      activeConversationId,
                      responseFeedbackGeneration,
                      turnId,
                      rating,
                    )}
                  />}
                {message.active && (
                  <div className="message-activity" role="status" aria-label="Rangabot is thinking">
                    <span className="thinking-runner" aria-hidden="true"><i /></span>
                    <span>Thinking</span>
                  </div>
                )}
                {message.stopped && (
                  <div className="stopped-state" role="status"><i aria-hidden="true" /> Stopped</div>
                )}
                {!message.active && (!message.turn || message.turn.status === "completed") && !message.error && <button type="button" className="reply-button" onClick={() => { setReplyTo(message); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); }} aria-label="Reply to this message"><CraftIcon name="reply" size={14} /><span>Reply</span></button>}
                {message.role === "assistant" && message.turn && (message.turn.status === "cancelled" || message.turn.status === "failed") && <button type="button" className="reply-button" onClick={() => copyTurnRequestText(message.turn!.id)} aria-label="Copy request text into the composer"><CraftIcon name="arrow" size={14} /><span>Copy request text</span></button>}
              </div>
            </article>
          ))}
          <div ref={endRef} />
        </div>

        <div className={`composer-wrap ${messages.length === 0 ? "empty-chat" : ""}`} inert={profileWorkspaceBlocked}>
          {!ready && <div className="setup-hint">
            <strong>{status?.available ? "Choose a local model" : "Starting RangaBot’s model engine"}</strong>
            <span>{status?.available ? "Open Model Manager to install or select a model—no terminal required." : "The private model engine is not ready yet."}</span>
            <button type="button" onClick={() => setModelManagerOpen(true)}>Model Manager</button>
          </div>}
          <form className="composer" onSubmit={sendMessage} aria-busy={conversationLoading || profileWorkspaceBlocked}>
            {replyTo && <div className="composer-reply"><span><strong>Replying to {replyTo.role === "assistant" ? "Rangabot" : "your message"}</strong>{replyTo.content.slice(0, 100)}</span><button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><CraftIcon name="close" size={14} /></button></div>}
            {attachedCodeContext && <div className="composer-code-context"><span><strong>Local code attached</strong>{attachedCodeContext.repositoryName} · {attachedCodeContext.path} · lines {attachedCodeContext.startLine}–{attachedCodeContext.endLine}<small>≈ {attachedCodeContext.characterCount.toLocaleString()} characters · sent only to Ollama when you press Send</small></span><button type="button" onClick={() => setAttachedCodeContext(null)} aria-label="Remove attached code"><CraftIcon name="close" size={14} /></button></div>}
            {attachedDataset && <div className="composer-code-context"><span><strong>Local data available to this chat</strong>{attachedDataset.name} · {attachedDataset.format.toUpperCase()} · {(attachedDataset.sizeBytes / 1024 ** 2).toFixed(1)} MB<small>This attachment is remembered for this chat. Analytical requests may run bounded read-only SQL locally; expand the calculation trace to inspect it.</small></span><button type="button" onClick={() => void attachDatasetToChat(null)} aria-label="Remove attached dataset"><CraftIcon name="close" size={14} /></button></div>}
            <div className="composer-main-row">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Message Rangabot…"
                rows={1}
                disabled={profileWorkspaceBlocked}
              />
              <div className="composer-actions">
                <select value={mode} onChange={(event) => setMode(event.target.value as Mode)} aria-label="Routing mode" aria-describedby="route-mode-description" title={routeDescription} disabled={profileWorkspaceBlocked}>
                  <option value="local">Local only</option>
                  <option value="smart">Smart</option>
                  <option value="teach">Teacher</option>
                  <option value="codex">Codex</option>
                </select>
                <span id="route-mode-description" className="sr-only">{routeDescription}</span>
                {sending ? (
                  <button className="stop-button" type="button" onClick={stopGenerating} aria-label="Stop generating"><CraftIcon name="stop" /></button>
                ) : (
                  <button type="submit" disabled={!input.trim() || conversationLoading || profileWorkspaceBlocked} aria-label="Send"><CraftIcon name="send" /></button>
                )}
              </div>
            </div>
          </form>
          <small>Local models can make mistakes. Review important code and decisions.</small>
        </div>
      </section>

      {!profileRecoveryRequired && wordPreview && <div className="word-preview-backdrop" onMouseDown={closeWordPreview}>
        <section className="word-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="word-preview-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><h2 id="word-preview-title">{wordPreview.title}</h2><button ref={wordPreviewCloseRef} type="button" onClick={closeWordPreview} aria-label="Close document preview"><CraftIcon name="close" /></button></header>
          {/* The preview bytes arrived through the profile-bound same-origin client before this private blob URL was created. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={wordPreview.url} alt={`First-page preview of ${wordPreview.title}`} />
        </section>
      </div>}

      {!profileRecoveryRequired && knowledgePanelOpen && (
        <div className="knowledge-backdrop" onMouseDown={() => setKnowledgePanelOpen(false)}>
          <aside className="knowledge-panel" role="dialog" aria-modal="true" aria-labelledby="knowledge-panel-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="knowledge-panel-header">
              <div><span>Local intelligence</span><h2 id="knowledge-panel-title">Knowledge Brief</h2><small>Active profile: {activeProfileContext?.marker ?? "Loading…"}</small></div>
              <button type="button" ref={knowledgeCloseRef} onClick={() => setKnowledgePanelOpen(false)} aria-label="Close Knowledge Brief"><CraftIcon name="close" /></button>
            </div>
            <nav className="knowledge-tabs" aria-label="Knowledge Brief sections">
              <button type="button" className={knowledgeTab === "discover" ? "active" : ""} onClick={() => setKnowledgeTab("discover")}>Discover</button>
              <button type="button" className={knowledgeTab === "vault" ? "active" : ""} onClick={() => setKnowledgeTab("vault")}>Vault</button>
              <button type="button" className={knowledgeTab === "updates" ? "active" : ""} onClick={() => setKnowledgeTab("updates")}>Rangabot updates</button>
            </nav>
            <div className="knowledge-panel-content">
              {knowledgeTab === "discover" && <>
                <div className="knowledge-period" aria-label="Brief period">
                  <button type="button" className={knowledgePeriod === "week" ? "active" : ""} onClick={() => setKnowledgePeriod("week")}>This week</button>
                  <button type="button" className={knowledgePeriod === "month" ? "active" : ""} onClick={() => setKnowledgePeriod("month")}>This month</button>
                </div>
                {knowledgePeriod === "week" ? (
                  <div className="brief-list">
                    {weeklyBrief.length === 0 && <p className="knowledge-empty">No verified updates are available this week.</p>}
                    {weeklyBrief.map((item) => <article className="brief-card" key={`${item.category}-${item.title}`}>
                      <div className="brief-meta"><span>{item.category}</span><time>{item.date}</time></div>
                      <h3>{item.title}</h3>
                      <p>{item.change}</p>
                      <div className="brief-why"><strong>Why it matters</strong><p>{item.why}</p></div>
                      <div className="brief-footer">
                        {item.evidenceUrl ? <a href={item.evidenceUrl} target="_blank" rel="noreferrer">{item.evidenceLabel || "Source"}</a> : <span>{item.evidenceLabel}</span>}
                        <small>{item.vaultStatus}</small>
                      </div>
                      <button type="button" className="ask-update" onClick={() => askAboutUpdate(item.title)}>Ask Rangabot about this <CraftIcon name="arrow" size={14} /></button>
                    </article>)}
                  </div>
                ) : <div className="knowledge-markdown"><MarkdownMessage content={knowledgeUpdates?.month ?? "No monthly brief is available yet."} /></div>}
              </>}
              {knowledgeTab === "vault" && <section className="vault-overview">
                <div className="vault-stat-grid">
                  <div><strong>{knowledgeStatus?.documents ?? "—"}</strong><span>Documents</span></div>
                  <div><strong>{knowledgeStatus?.chunks ?? "—"}</strong><span>Passages</span></div>
                  <div><strong>{knowledgeStatus ? `${(knowledgeStatus.usedBytes / 1024 ** 2).toFixed(0)} MB` : "—"}</strong><span>Local storage</span></div>
                </div>
                {knowledgeStatus && <><progress value={knowledgeStatus.usedBytes} max={knowledgeStatus.budgetBytes} aria-label="Knowledge Vault storage used" /><p>{((knowledgeStatus.usedBytes / knowledgeStatus.budgetBytes) * 100).toFixed(1)}% of the private 4 GB budget used.</p></>}
                {knowledgeStatus && (knowledgeStatus.incompatible > 0 || knowledgeStatus.pending > 0) && <div className="vault-source-list" aria-label="Knowledge sources needing attention">
                  <div className="vault-source-heading"><strong>Needs attention</strong><span>{knowledgeStatus.incompatible} incompatible · {knowledgeStatus.pending} pending</span></div>
                  {knowledgeStatus.sources.filter((source) => source.status !== "indexed").map((source) => <div className={`vault-source ${source.status}`} key={source.name}>
                    <span>{source.status}</span><div><strong>{source.name}</strong><small>{source.detail}</small></div>
                  </div>)}
                </div>}
                <div className="vault-note"><strong>Private by design</strong><p>Documents, passages, embeddings and retrieval stay in this active profile on this computer. Use the supported Knowledge ingestion flow; it binds ingestion to the exact active profile and never uses the legacy shared data path.</p></div>
              </section>}
              {knowledgeTab === "updates" && <div className="knowledge-markdown changelog"><MarkdownMessage content={knowledgeUpdates?.changelog ?? "No Rangabot changelog is available yet."} /></div>}
            </div>
          </aside>
        </div>
      )}

      {!profileRecoveryRequired && repositoryPanelOpen && selectedRepository && (
        <div className="knowledge-backdrop" onMouseDown={() => setRepositoryPanelOpen(false)}>
          <aside className="code-panel" role="dialog" aria-modal="true" aria-labelledby="code-panel-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="knowledge-panel-header">
              <div><span>Approved folder · local only</span><h2 id="code-panel-title">{selectedRepository.name}</h2><small>Active profile: {activeProfileContext?.marker ?? "Loading…"}</small><small>{selectedRepository.path}</small></div>
              <button type="button" ref={repositoryCloseRef} onClick={() => setRepositoryPanelOpen(false)} aria-label="Close code search"><CraftIcon name="close" /></button>
            </div>
            <form className="code-search-form" onSubmit={searchAllowedRepository}>
              <input value={codeQuery} onChange={(event) => setCodeQuery(event.target.value)} placeholder="Search code and text files" aria-label="Search repository code" minLength={2} maxLength={120} />
              <button type="submit" disabled={codeSearching || codeQuery.trim().length < 2}>{codeSearching ? "Searching…" : "Search"}</button>
              <p>Reads eligible files in this approved folder only when you submit.</p>
            </form>
            <div className="code-workspace">
              <section className="code-results" aria-label="Code search results">
                <div className="code-section-heading"><span>Matches</span><small>{codeSearchMessage}</small></div>
                {codeResults.map((result) => <button type="button" key={`${result.path}:${result.line}`} onClick={() => void openCodePreview(result)} className={codePreview?.path === result.path && codePreview.focusLine === result.line ? "active" : ""}>
                  <strong>{result.path}<span>:{result.line}</span></strong><small>{result.excerpt || "Blank matching line"}</small>
                </button>)}
                {!codeResults.length && <p>Search an approved repository to see up to 50 matches.</p>}
              </section>
              <section className="code-preview" aria-label="Local file preview">
                {codePreview ? <><div className="code-section-heading"><span>{codePreview.path}</span><small>Lines {codePreview.startLine}–{codePreview.startLine + codePreview.lines.length - 1}</small></div><button type="button" className="attach-code-button" onClick={attachCodePreview}>Attach preview to chat</button><pre>{codePreview.lines.map((line, index) => {
                  const lineNumber = codePreview.startLine + index;
                  return <code className={lineNumber === codePreview.focusLine ? "focus" : ""} key={lineNumber}><b>{lineNumber}</b><span>{line || " "}</span></code>;
                })}</pre></> : <div className="code-preview-empty"><strong>File context</strong><p>Select a match to read a bounded local preview.</p></div>}
              </section>
            </div>
          </aside>
        </div>
      )}
      <MemoryPanel open={!profileRecoveryRequired && memoryPanelOpen} onClose={closeMemoryPanel} activeProfileMarker={activeProfileContext?.marker ?? "Loading…"} />
      <SqlAnalysisPanel key={sqlDraft ? `${sqlDraft.datasetId}:${sqlDraft.query}` : "manual"} open={!profileRecoveryRequired && sqlPanelOpen} onClose={closeSqlPanel} onAttach={(dataset) => { void attachDatasetToChat(dataset); setSqlDraft(null); }} initialDraft={sqlDraft} activeProfileMarker={activeProfileContext?.marker ?? "Loading…"} />
      {!profileRecoveryRequired && welcomePreferencesOpen && <WelcomePreferencesDialog preferences={welcomePreferences} appearance={appearance} palette={palette} activeProfileMarker={activeProfileContext?.marker ?? "Loading…"} onClose={closeWelcomePreferences} onSave={saveWelcomePreferences} />}
      {!profileRecoveryRequired && modelManagerOpen && <ModelManager activeProfileMarker={activeProfileContext?.marker ?? "Loading…"} onClose={() => setModelManagerOpen(false)} onChanged={() => void refreshStatus()} />}
    </main>
  );
}
