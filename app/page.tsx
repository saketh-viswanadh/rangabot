"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ProviderStatus } from "@/lib/providers/types";
import { appendWelcomeHistory, chooseWelcomeIndex, parseWelcomeHistory, welcomeLines } from "@/lib/welcome-content";
import { isNearMessageBottom } from "@/lib/message-scroll";
import { parseKnowledgeBrief } from "@/lib/knowledge-brief";
import { CraftIcon } from "@/app/components/craft-icon";
import { formatAnswerReceipt } from "@/lib/answer-receipt";
import { SqlAnalysisPanel } from "@/app/components/sql-analysis-panel";
import type { AttachedDataset, SqlDraft } from "@/lib/sql-display";
import { parseAnalysisTraceHeader, parsePackWarningsHeader } from "@/lib/chat-validation";

const MemoryPanel = dynamic(
  () => import("@/app/components/memory-panel").then((module) => module.MemoryPanel),
  { ssr: false },
);
const MarkdownMessage = dynamic(
  () => import("@/components/MarkdownMessage").then((module) => module.MarkdownMessage),
  { ssr: false, loading: () => <span className="message-loading">Preparing response…</span> },
);

type Mode = "local" | "smart" | "teach" | "codex";
type Appearance = "light" | "dark";
type Palette = "sand" | "sage" | "lavender";
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

export default function Home() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [welcomeIndex, setWelcomeIndex] = useState(0);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("smart");
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [palette, setPalette] = useState<Palette>("sand");
  const [replyTo, setReplyTo] = useState<DisplayMessage | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [sending, setSending] = useState(false);
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
  const followLatestRef = useRef(true);
  const knowledgeCloseRef = useRef<HTMLButtonElement>(null);
  const conversationImportRef = useRef<HTMLInputElement>(null);
  const repositoryCloseRef = useRef<HTMLButtonElement>(null);
  const closeMemoryPanel = useCallback(() => setMemoryPanelOpen(false), []);
  const closeSqlPanel = useCallback(() => setSqlPanelOpen(false), []);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      setStatus(await response.json());
    } catch {
      setStatus(null);
    }
  }

  async function refreshConversations(query = conversationSearch, projectId = activeProjectId) {
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set("query", query.trim());
    if (projectId) parameters.set("projectId", projectId);
    const response = await fetch(`/api/conversations${parameters.size ? `?${parameters}` : ""}`, { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations);
    }
  }

  async function refreshProjects() {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (response.ok) setProjects(((await response.json()) as { projects: ProjectSummary[] }).projects);
  }

  async function refreshRepositories() {
    const response = await fetch("/api/repositories", { cache: "no-store" });
    const data = (await response.json()) as { repositories?: AllowedRepository[]; error?: string };
    if (response.ok && data.repositories) setAllowedRepositories(data.repositories);
    else setRepositoryMessage(data.error ?? "Could not read allowed folders.");
  }

  async function allowLocalRepository(event: FormEvent) {
    event.preventDefault();
    const path = repositoryPath.trim();
    if (!path) return;
    const response = await fetch("/api/repositories", {
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
    const response = await fetch(`/api/repositories/${repository.id}`, { method: "DELETE" });
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
    const response = await fetch(`/api/repositories/${selectedRepository.id}/search?${parameters}`, { cache: "no-store" });
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
    const response = await fetch(`/api/repositories/${selectedRepository.id}/preview?${parameters}`, { cache: "no-store" });
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
    const [statusResponse, updatesResponse] = await Promise.all([fetch("/api/knowledge/status", { cache: "no-store" }), fetch("/api/knowledge/updates", { cache: "no-store" })]);
    if (statusResponse.ok) setKnowledgeStatus(await statusResponse.json());
    if (updatesResponse.ok) setKnowledgeUpdates(await updatesResponse.json());
  }

  async function createNewProject(event: FormEvent) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
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
    const response = await fetch(`/api/projects/${project.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (response.ok) await refreshProjects();
  }

  async function removeProject(project: ProjectSummary) {
    if (!window.confirm(`Delete “${project.name}”? Its chats will move to All chats.`)) return;
    const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!response.ok) return;
    if (activeProjectId === project.id) setActiveProjectId(null);
    await Promise.all([refreshProjects(), refreshConversations()]);
  }

  async function openConversation(id: string) {
    if (sending) return;
    const response = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { conversation: { messages: ChatMessage[] }; attachedDataset: AttachedDataset | null };
    followLatestRef.current = true;
    setMessages(data.conversation.messages.map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      source: message.role === "assistant" ? "local" : undefined,
      knowledgeUsed: Boolean(message.retrievalMode),
    })));
    setActiveConversationId(id);
    setAttachedCodeContext(null);
    setAttachedDataset(data.attachedDataset);
    setSqlDraft(null);
  }

  async function attachDatasetToChat(dataset: AttachedDataset | null) {
    if (!activeConversationId) {
      setAttachedDataset(dataset);
      return;
    }
    const response = await fetch(`/api/conversations/${activeConversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasetId: dataset?.id ?? null }),
    });
    if (response.ok) setAttachedDataset(dataset);
  }

  async function removeConversation(id: string) {
    if (sending) return;
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) return;
    if (activeConversationId === id) startNewChat();
    await refreshConversations();
  }

  async function toggleConversationPin(conversation: ConversationSummary) {
    const response = await fetch(`/api/conversations/${conversation.id}`, {
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
    const response = await fetch("/api/conversations/import", {
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
    const savedAppearance = localStorage.getItem("rangabot-appearance") as Appearance | null;
    const savedPalette = localStorage.getItem("rangabot-palette") as Palette | null;
    if (savedAppearance === "light" || savedAppearance === "dark") setAppearance(savedAppearance);
    if (["sand", "sage", "lavender"].includes(savedPalette ?? "")) setPalette(savedPalette as Palette);
    setReadKnowledgeVersion(localStorage.getItem("rangabot-knowledge-read"));
    setWelcomeIndex((current) => nextWelcomeIndex(current));
    void refreshStatus();
    void refreshProjects();
    void refreshRepositories();
    void refreshKnowledge();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const parameters = new URLSearchParams();
      if (conversationSearch.trim()) parameters.set("query", conversationSearch.trim());
      if (activeProjectId) parameters.set("projectId", activeProjectId);
      const response = await fetch(`/api/conversations${parameters.size ? `?${parameters}` : ""}`, {
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
    localStorage.setItem("rangabot-knowledge-read", knowledgeUpdates.weekUpdatedAt);
    setReadKnowledgeVersion(knowledgeUpdates.weekUpdatedAt);
  }, [knowledgePanelOpen, knowledgeTab, knowledgeUpdates?.weekUpdatedAt]);
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("demo") !== "knowledge") return;
    setAppearance(parameters.get("theme") === "light" ? "light" : "dark");
    setPalette("sage");
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
    if (followLatestRef.current) endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

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
    const userMessage: DisplayMessage = { id: crypto.randomUUID(), role: "user", content, replyTo: reference, codeContext };
    const assistantId = crypto.randomUUID();
    const nextMessages = [...messages, userMessage];
    const storedMessages = nextMessages.map(({ role, content: text, replyTo: reply, codeContext: code, artifactIntent, wordArtifact, analysisTrace, retrievalMode, memoryUse, memoryTitles, answerDisposition }) => ({ role, content: text, ...(reply ? { replyTo: reply } : {}), ...(code ? { codeContext: code } : {}), ...(artifactIntent ? { artifactIntent } : {}), ...(wordArtifact ? { wordArtifact } : {}), ...(analysisTrace ? { analysisTrace } : {}), ...(retrievalMode ? { retrievalMode } : {}), ...(memoryUse ? { memoryUse } : {}), ...(memoryTitles?.length ? { memoryTitles } : {}), ...(answerDisposition ? { answerDisposition } : {}) }));
    let conversationId = activeConversationId;
    if (!conversationId) {
      const createResponse = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: storedMessages,
          projectId: activeProjectId,
          ...(attachedDataset ? { datasetId: attachedDataset.id } : {}),
        }),
      });
      if (createResponse.ok) {
        const data = (await createResponse.json()) as { conversation: { id: string } };
        conversationId = data.conversation.id;
        setActiveConversationId(conversationId);
        void refreshConversations();
      }
    }
    followLatestRef.current = true;
    setMessages((current) => [...current, userMessage, {
      id: assistantId,
      role: "assistant",
      content: "",
      source: "local",
      active: true,
    }]);
    setInput("");
    setReplyTo(null);
    setSending(true);
    const abortController = new AbortController();
    abortRef.current = abortController;
    let generatedContent = "";
    let finalAssistant: ChatMessage | null = null;
    let responseArtifactIntent: ChatMessage["artifactIntent"];
    let responseWordArtifact: ChatMessage["wordArtifact"];
    let responseMemoryUse: ChatMessage["memoryUse"];
    let responseMemoryTitles: ChatMessage["memoryTitles"];
    let responseAnalysisTrace: ChatMessage["analysisTrace"];
    let responseAnswerDisposition: ChatMessage["answerDisposition"];

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          mode,
          ...(conversationId ? { conversationId } : {}),
          ...(codeContextForRequest ? { codeContext: { repositoryId: codeContextForRequest.repositoryId, path: codeContextForRequest.path, line: codeContextForRequest.line } } : {}),
          ...(attachedDataset ? { datasetId: attachedDataset.id } : {}),
          messages: nextMessages.map(({ role, content: text, replyTo: reply, artifactIntent, wordArtifact, analysisTrace }) => ({
            role,
            content: reply ? `[Replying to ${reply.role}: “${reply.excerpt}”]\n\n${text}` : text,
            ...(artifactIntent ? { artifactIntent } : {}),
            ...(wordArtifact ? { wordArtifact } : {}),
            ...(analysisTrace ? { analysisTrace } : {}),
          })),
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Request failed");
      }
      setAttachedCodeContext(null);
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
      responseAnswerDisposition = parsePackWarningsHeader(response.headers.get("X-Rangabot-Pack-Warnings")) ?? undefined;
      if (!responseAnalysisTrace?.packId) responseAnswerDisposition = undefined;
      if (responseAnalysisTrace) {
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, analysisTrace: responseAnalysisTrace, ...(responseAnswerDisposition ? { answerDisposition: responseAnswerDisposition } : {}) }
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
        generatedContent += chunk;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content + chunk, active: true } : message
        )));
      }
      const finalChunk = decoder.decode();
      if (finalChunk) {
        receivedContent = true;
        generatedContent += finalChunk;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content + finalChunk, active: true } : message
        )));
      }
      if (!receivedContent) throw new Error("The local model returned an empty response.");
      finalAssistant = { role: "assistant", content: generatedContent, ...(responseArtifactIntent ? { artifactIntent: responseArtifactIntent } : {}), ...(responseWordArtifact ? { wordArtifact: responseWordArtifact } : {}), ...(responseAnalysisTrace ? { analysisTrace: responseAnalysisTrace } : {}), ...(responseAnswerDisposition ? { answerDisposition: responseAnswerDisposition } : {}), ...(retrievalMode ? { retrievalMode } : {}), ...(responseMemoryUse ? { memoryUse: responseMemoryUse } : {}), ...(responseMemoryTitles?.length ? { memoryTitles: responseMemoryTitles } : {}) };
    } catch (error) {
      const stopped = abortController.signal.aborted;
      finalAssistant = {
        role: "assistant",
        content: stopped
          ? generatedContent || "No response was generated."
          : error instanceof Error ? error.message : "The request failed.",
      };
      setMessages((current) => current.map((message) => {
        if (message.id !== assistantId) return message;
        if (stopped) {
          return {
            ...message,
            content: message.content
              ? message.content
              : "No response was generated.",
            active: false,
            stopped: true,
          };
        }
        return {
          ...message,
          content: error instanceof Error ? error.message : "The request failed.",
          error: true,
          source: undefined,
          active: false,
        };
      }));
      if (!stopped) void refreshStatus();
    } finally {
      setMessages((current) => current.map((message) => (
        message.id === assistantId ? { ...message, active: false } : message
      )));
      setSending(false);
      abortRef.current = null;
      if (conversationId && finalAssistant) {
        await fetch(`/api/conversations/${conversationId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [...storedMessages, finalAssistant] }),
        });
        void refreshConversations();
      }
    }
  }

  function stopGenerating() {
    abortRef.current?.abort();
  }

  function startNewChat(projectId: string | null = activeProjectId) {
    abortRef.current?.abort();
    followLatestRef.current = true;
    setMessages([]);
    setActiveConversationId(null);
    setActiveProjectId(projectId);
    setInput("");
    setReplyTo(null);
    setAttachedCodeContext(null);
    setAttachedDataset(null);
    setWelcomeIndex((current) => nextWelcomeIndex(current));
  }

  function nextWelcomeIndex(current: number) {
    const history = parseWelcomeHistory(localStorage.getItem("rangabot-welcome-history"));
    const next = chooseWelcomeIndex(current, history);
    localStorage.setItem("rangabot-welcome-history", JSON.stringify(appendWelcomeHistory(history, next)));
    return next;
  }

  function chooseStarter(prompt: string) {
    setInput(prompt);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  const ready = status?.available && status.modelInstalled;
  const visibleConversations = conversations;
  const weeklyBrief = useMemo(() => parseKnowledgeBrief(knowledgeUpdates?.week ?? ""), [knowledgeUpdates?.week]);
  const unreadKnowledge = knowledgeUpdates?.weekUpdatedAt && knowledgeUpdates.weekUpdatedAt !== readKnowledgeVersion
    ? weeklyBrief.length
    : 0;

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

  function changeAppearance(next: Appearance) {
    setAppearance(next);
    localStorage.setItem("rangabot-appearance", next);
  }

  function changePalette(next: Palette) {
    setPalette(next);
    localStorage.setItem("rangabot-palette", next);
  }

  return (
    <main className="app-shell" data-appearance={appearance} data-palette={palette} onPointerMove={followCursor}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><span>Rangabot</span></div>
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
            ? <a href={`/api/conversations/${activeConversationId}/export`}>Export open chat</a>
            : <span aria-disabled="true">Export open chat</span>}
          <input ref={conversationImportRef} type="file" accept=".md,text/markdown,text/plain" onChange={(event) => void importConversation(event)} />
        </div>
        {conversationTransferMessage && <p className="conversation-transfer-status" role="status">{conversationTransferMessage}</p>}
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

      <section className="chat-panel">
        <header>
          <div><h1>Rangabot</h1><p>Code, think, and build privately</p></div>
          <div className="header-actions">
            <nav className="utility-rail" aria-label="Rangabot tools">
              <button type="button" className="utility-button" onClick={() => openKnowledgeBrief()} aria-label={`Open Knowledge Brief${unreadKnowledge ? `, ${unreadKnowledge} new items` : ""}`}>
                <CraftIcon name="knowledge" size={15} /><span>Brief</span>{unreadKnowledge > 0 && <b>{unreadKnowledge}</b>}
              </button>
              <button type="button" className="utility-button" onClick={() => setMemoryPanelOpen(true)} aria-label="Open Local memory"><CraftIcon name="memory" size={15} /><span>Memory</span></button>
              <button type="button" className="utility-button" onClick={() => setSqlPanelOpen(true)} aria-label="Open private SQL analysis"><CraftIcon name="analysis" size={15} /><span>Analyze</span></button>
              <a className="utility-button" href="/mastery" aria-label="Open Path to Mastery"><CraftIcon name="mastery" size={15} /><span>Mastery</span></a>
              <details className="repository-menu">
                <summary className="utility-button"><CraftIcon name="folder" size={15} /><span>Folders</span>{allowedRepositories.length > 0 && <b>{allowedRepositories.length}</b>}</summary>
                <section className="repository-popover" aria-label="Allowed local repositories">
                  <header><div><strong>Local folders</strong><small>Private, explicitly allowed</small></div><CraftIcon name="folder" size={16} /></header>
                  <div className="repository-popover-list">
                    {allowedRepositories.map((repository) => <div className="repository-item" key={repository.id} title={repository.path}>
                      <button type="button" className="repository-open" onClick={() => openRepositorySearch(repository)} aria-label={`Search ${repository.name}`}><CraftIcon name="search" /><span><strong>{repository.name}</strong><small>{repository.path}</small></span></button>
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
              </details>
              <span className="privacy-indicator" title="Private by default · nothing is sent to the cloud"><CraftIcon name="shield" size={15} /><span>Local</span></span>
            </nav>
            <div className="theme-picker" aria-label="Theme settings">
              <button type="button" className="appearance-toggle" onClick={() => changeAppearance(appearance === "dark" ? "light" : "dark")} aria-label={`Use ${appearance === "dark" ? "light" : "dark"} mode`}><CraftIcon name={appearance === "dark" ? "sun" : "moon"} size={15} /></button>
              {(["sand", "sage", "lavender"] as Palette[]).map((choice) => <button type="button" key={choice} className={`palette-dot ${choice} ${palette === choice ? "selected" : ""}`} onClick={() => changePalette(choice)} aria-label={`Use ${choice} palette`} />)}
            </div>
            <button className={`status ${ready ? "ready" : "offline"}`} onClick={refreshStatus}>
              <span /> {ready ? `${status.configuredModel} ready` : status?.available ? "Model not installed" : "Ollama offline"}
            </button>
          </div>
        </header>

        <div
          className="messages"
          onScroll={(event) => {
            const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
            followLatestRef.current = isNearMessageBottom(scrollTop, clientHeight, scrollHeight);
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) followLatestRef.current = false;
          }}
        >
          {messages.length === 0 && (
            <section className="welcome-state" aria-labelledby="welcome-title">
              <div className="ranga-scene" aria-hidden="true"><span className="butterfly one" /><span className="butterfly two" /><div className="welcome-orbit" /></div>
              <span className="welcome-kicker">{welcomeLines[welcomeIndex].kind}</span>
              <h2 id="welcome-title">A fresh conversation</h2>
              <blockquote>“{welcomeLines[welcomeIndex].text}”</blockquote>
              <cite>— {welcomeLines[welcomeIndex].credit}</cite>
              <div className="starter-grid" aria-label="Conversation starters">
                <button type="button" onClick={() => chooseStarter("Help me think through an idea: ")}>
                  <span className="starter-icon idea"><CraftIcon name="spark" /></span>
                  <span><strong>Explore an idea</strong><small>Brainstorm it locally</small></span>
                  <CraftIcon name="chevron" size={14} />
                </button>
                <button type="button" onClick={() => chooseStarter("Help me with this coding task: ")}>
                  <span className="starter-icon code"><CraftIcon name="code" /></span>
                  <span><strong>Build something</strong><small>Plan or improve code</small></span>
                  <CraftIcon name="chevron" size={14} />
                </button>
                <button type="button" onClick={() => chooseStarter("Help me write this email. Ask me for the audience, purpose, tone, and key details before drafting: ")}>
                  <span className="starter-icon mail"><CraftIcon name="mail" /></span>
                  <span><strong>Write an email</strong><small>Draft it locally in the right tone</small></span>
                  <CraftIcon name="chevron" size={14} />
                </button>
                <button type="button" onClick={() => chooseStarter("I want to create a professional Word document. Please ask me what you need before creating it: ")}>
                  <span className="starter-icon document"><CraftIcon name="document" /></span>
                  <span><strong>Create a Word document</strong><small>Draft, validate and preview locally</small></span>
                  <CraftIcon name="chevron" size={14} />
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
                {message.wordArtifact && <div className="chat-word-artifact"><span><CraftIcon name="document" /></span><div><strong>{message.wordArtifact.title}</strong><small>{message.wordArtifact.filename} · {message.wordArtifact.previewPages} rendered page{message.wordArtifact.previewPages === 1 ? "" : "s"}</small><nav><a href={`/api/artifacts/word/${message.wordArtifact.id}/document`}>Download .docx</a>{message.wordArtifact.previewPages > 0 && <a href={`/api/artifacts/word/${message.wordArtifact.id}/preview/1`} target="_blank" rel="noreferrer">Review preview</a>}</nav></div></div>}
                {message.source && <span className="source">{formatAnswerReceipt(message)}</span>}
                {message.content && (message.role === "assistant"
                  ? <MarkdownMessage content={message.content} />
                  : <p>{message.content}</p>)}
                {message.answerDisposition === "verified-fallback" && <div className="answer-disposition" role="status"><CraftIcon name="shield" size={13} /><span><strong>Verified result fallback</strong>Rangabot answered directly from the checked local calculation.</span></div>}
                {message.analysisTrace && <details className="analysis-trace"><summary><CraftIcon name="analysis" size={14} />How this was calculated</summary><div><span><strong>{message.analysisTrace.dataset}</strong>{message.analysisTrace.returnedRows} verified row{message.analysisTrace.returnedRows === 1 ? "" : "s"} · {message.analysisTrace.durationMs} ms{message.analysisTrace.truncated ? " · bounded result" : ""}</span><pre><code>{message.analysisTrace.query}</code></pre><small>Input {message.analysisTrace.inputSha256.slice(0, 12)}… · Query {message.analysisTrace.querySha256.slice(0, 12)}… · local DuckDB{message.analysisTrace.packId ? ` · ${message.analysisTrace.packId} pack ${message.analysisTrace.packVersion ?? ""}` : ""}{message.analysisTrace.modelId ? ` · ${message.analysisTrace.modelMode ?? "general"} model ${message.analysisTrace.modelId}` : ""}</small></div></details>}
                {message.active && (
                  <div className="message-activity" role="status" aria-label="Rangabot is thinking">
                    <span className="thinking-runner" aria-hidden="true"><i /></span>
                    <span>Thinking</span>
                  </div>
                )}
                {message.stopped && (
                  <div className="stopped-state" role="status"><i aria-hidden="true" /> Stopped</div>
                )}
                {!message.active && !message.error && <button type="button" className="reply-button" onClick={() => { setReplyTo(message); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); }} aria-label="Reply to this message"><CraftIcon name="reply" size={14} /><span>Reply</span></button>}
              </div>
            </article>
          ))}
          <div ref={endRef} />
        </div>

        <div className="composer-wrap">
          {!ready && <div className="setup-hint">
            <strong>{status?.available ? "Install the configured model" : "Start Ollama to chat"}</strong>
            <span>{status?.available ? `Run: ollama pull ${status.configuredModel}` : "The app is ready and waiting for the local model service."}</span>
          </div>}
          <form className="composer" onSubmit={sendMessage}>
            {replyTo && <div className="composer-reply"><span><strong>Replying to {replyTo.role === "assistant" ? "Rangabot" : "your message"}</strong>{replyTo.content.slice(0, 100)}</span><button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><CraftIcon name="close" size={14} /></button></div>}
            {attachedCodeContext && <div className="composer-code-context"><span><strong>Local code attached</strong>{attachedCodeContext.repositoryName} · {attachedCodeContext.path} · lines {attachedCodeContext.startLine}–{attachedCodeContext.endLine}<small>≈ {attachedCodeContext.characterCount.toLocaleString()} characters · sent only to Ollama when you press Send</small></span><button type="button" onClick={() => setAttachedCodeContext(null)} aria-label="Remove attached code"><CraftIcon name="close" size={14} /></button></div>}
            {attachedDataset && <div className="composer-code-context"><span><strong>Local data available to this chat</strong>{attachedDataset.name} · {attachedDataset.format.toUpperCase()} · {(attachedDataset.sizeBytes / 1024 ** 2).toFixed(1)} MB<small>This attachment is remembered for this chat. Analytical requests may run bounded read-only SQL locally; expand the calculation trace to inspect it.</small></span><button type="button" onClick={() => void attachDatasetToChat(null)} aria-label="Remove attached dataset"><CraftIcon name="close" size={14} /></button></div>}
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask about code, brainstorm an idea, or plan your next project…"
              rows={2}
            />
            <div className="composer-actions">
              <select value={mode} onChange={(event) => setMode(event.target.value as Mode)} aria-label="Routing mode">
                <option value="local">Local only</option>
                <option value="smart">Smart routing</option>
                <option value="teach">Teacher mode</option>
                <option value="codex">Codex</option>
              </select>
              <span className="route-note">{mode === "codex" ? "Cloud handoff not enabled" : mode === "teach" ? "Strict vault teaching with citations" : mode === "smart" ? "Automatically uses local knowledge" : "Stays on this computer"}</span>
              {sending ? (
                <button className="stop-button" type="button" onClick={stopGenerating} aria-label="Stop generating"><CraftIcon name="stop" /></button>
              ) : (
                <button type="submit" disabled={!input.trim()} aria-label="Send"><CraftIcon name="send" /></button>
              )}
            </div>
          </form>
          <small>Local models can make mistakes. Review important code and decisions.</small>
        </div>
      </section>

      {knowledgePanelOpen && (
        <div className="knowledge-backdrop" onMouseDown={() => setKnowledgePanelOpen(false)}>
          <aside className="knowledge-panel" role="dialog" aria-modal="true" aria-labelledby="knowledge-panel-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="knowledge-panel-header">
              <div><span>Local intelligence</span><h2 id="knowledge-panel-title">Knowledge Brief</h2></div>
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
                <div className="vault-note"><strong>Private by design</strong><p>Documents, passages, embeddings and retrieval stay on this computer. Add material to <code>data/knowledge/inbox/</code> and run <code>npm run knowledge:ingest</code>.</p></div>
              </section>}
              {knowledgeTab === "updates" && <div className="knowledge-markdown changelog"><MarkdownMessage content={knowledgeUpdates?.changelog ?? "No Rangabot changelog is available yet."} /></div>}
            </div>
          </aside>
        </div>
      )}

      {repositoryPanelOpen && selectedRepository && (
        <div className="knowledge-backdrop" onMouseDown={() => setRepositoryPanelOpen(false)}>
          <aside className="code-panel" role="dialog" aria-modal="true" aria-labelledby="code-panel-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="knowledge-panel-header">
              <div><span>Approved folder · local only</span><h2 id="code-panel-title">{selectedRepository.name}</h2><small>{selectedRepository.path}</small></div>
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
      <MemoryPanel open={memoryPanelOpen} onClose={closeMemoryPanel} />
      <SqlAnalysisPanel key={sqlDraft ? `${sqlDraft.datasetId}:${sqlDraft.query}` : "manual"} open={sqlPanelOpen} onClose={closeSqlPanel} onAttach={(dataset) => { void attachDatasetToChat(dataset); setSqlDraft(null); }} initialDraft={sqlDraft} />
    </main>
  );
}
