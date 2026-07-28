"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { ChatMessage, ProviderStatus } from "@/lib/providers/types";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { welcomeLines } from "@/lib/welcome-content";

type Mode = "local" | "smart" | "codex";
type Appearance = "light" | "dark";
type Palette = "sand" | "sage" | "lavender";
type DisplayMessage = ChatMessage & {
  id: string;
  source?: "local";
  error?: boolean;
  active?: boolean;
  stopped?: boolean;
};
type ConversationSummary = {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};
type ProjectSummary = { id: string; name: string; createdAt: string; updatedAt: string };

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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      setStatus(await response.json());
    } catch {
      setStatus(null);
    }
  }

  async function refreshConversations() {
    const response = await fetch("/api/conversations", { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations);
    }
  }

  async function refreshProjects() {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (response.ok) setProjects(((await response.json()) as { projects: ProjectSummary[] }).projects);
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
    const data = (await response.json()) as { conversation: { messages: ChatMessage[] } };
    setMessages(data.conversation.messages.map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      source: message.role === "assistant" ? "local" : undefined,
    })));
    setActiveConversationId(id);
  }

  async function removeConversation(id: string) {
    if (sending) return;
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) return;
    if (activeConversationId === id) startNewChat();
    await refreshConversations();
  }

  useEffect(() => {
    const savedAppearance = localStorage.getItem("rangabot-appearance") as Appearance | null;
    const savedPalette = localStorage.getItem("rangabot-palette") as Palette | null;
    if (savedAppearance === "light" || savedAppearance === "dark") setAppearance(savedAppearance);
    if (["sand", "sage", "lavender"].includes(savedPalette ?? "")) setPalette(savedPalette as Palette);
    void refreshStatus();
    void refreshConversations();
    void refreshProjects();
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    const reference = replyTo ? {
      role: replyTo.role as "user" | "assistant",
      excerpt: replyTo.content.slice(0, 160),
    } : undefined;
    const userMessage: DisplayMessage = { id: crypto.randomUUID(), role: "user", content, replyTo: reference };
    const assistantId = crypto.randomUUID();
    const nextMessages = [...messages, userMessage];
    const storedMessages = nextMessages.map(({ role, content: text, replyTo: reply }) => ({ role, content: text, ...(reply ? { replyTo: reply } : {}) }));
    let conversationId = activeConversationId;
    if (!conversationId) {
      const createResponse = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: storedMessages, projectId: activeProjectId }),
      });
      if (createResponse.ok) {
        const data = (await createResponse.json()) as { conversation: { id: string } };
        conversationId = data.conversation.id;
        setActiveConversationId(conversationId);
        void refreshConversations();
      }
    }
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

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          mode,
          messages: nextMessages.map(({ role, content: text, replyTo: reply }) => ({
            role,
            content: reply ? `[Replying to ${reply.role}: “${reply.excerpt}”]\n\n${text}` : text,
          })),
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Request failed");
      }
      if (!response.body) throw new Error("The local model returned no response stream.");

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
      finalAssistant = { role: "assistant", content: generatedContent };
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
    setMessages([]);
    setActiveConversationId(null);
    setActiveProjectId(projectId);
    setInput("");
    setReplyTo(null);
    setWelcomeIndex((current) => (current + 1 + Math.floor(Math.random() * (welcomeLines.length - 1))) % welcomeLines.length);
  }

  function chooseStarter(prompt: string) {
    setInput(prompt);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  const ready = status?.available && status.modelInstalled;
  const visibleConversations = activeProjectId
    ? conversations.filter((conversation) => conversation.projectId === activeProjectId)
    : conversations;

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
        <button className="new-chat" onClick={() => startNewChat()}>＋ New chat</button>
        <section className="projects" aria-label="Projects">
          <div className="project-heading"><span>Projects</span><span>{projects.length}</span></div>
          <button type="button" className={`project-row ${activeProjectId === null ? "active" : ""}`} onClick={() => { setActiveProjectId(null); startNewChat(null); }}><span>▱</span> All chats</button>
          {projects.map((project) => <div className={`project-item ${activeProjectId === project.id ? "active" : ""}`} key={project.id}>
            <button type="button" className="project-row" onClick={() => { setActiveProjectId(project.id); startNewChat(project.id); }}><span>▰</span>{project.name}</button>
            <button type="button" className="project-more" onClick={() => void renameProject(project)} aria-label={`Rename ${project.name}`}>✎</button>
            <button type="button" className="project-more" onClick={() => void removeProject(project)} aria-label={`Delete ${project.name}`}>×</button>
          </div>)}
          <form className="project-create" onSubmit={createNewProject}><input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="New project" maxLength={60} aria-label="New project name" /><button type="submit" disabled={!newProjectName.trim()} aria-label="Create project">＋</button></form>
        </section>
        <nav className="history">
          <span className="nav-label">{activeProjectId ? "Project chats" : "Recent chats"}</span>
          {visibleConversations.length === 0 && <p className="history-empty">Your local conversations will appear here.</p>}
          {visibleConversations.map((conversation) => (
            <div className={`history-row ${conversation.id === activeConversationId ? "active" : ""}`} key={conversation.id}>
              <button type="button" onClick={() => void openConversation(conversation.id)}>{conversation.title}</button>
              <button type="button" className="delete-chat" onClick={() => void removeConversation(conversation.id)} aria-label={`Delete ${conversation.title}`}>×</button>
            </div>
          ))}
        </nav>
        <div className="privacy-card">
          <span className="shield">◆</span>
          <div><strong>Private by default</strong><p>Nothing is sent to the cloud in this milestone.</p></div>
        </div>
      </aside>

      <section className="chat-panel">
        <header>
          <div><h1>Rangabot</h1><p>Code, think, and build privately</p></div>
          <div className="header-actions">
            <div className="theme-picker" aria-label="Theme settings">
              <button type="button" className="appearance-toggle" onClick={() => changeAppearance(appearance === "dark" ? "light" : "dark")} aria-label={`Use ${appearance === "dark" ? "light" : "dark"} mode`}>{appearance === "dark" ? "☀︎" : "☾"}</button>
              {(["sand", "sage", "lavender"] as Palette[]).map((choice) => <button type="button" key={choice} className={`palette-dot ${choice} ${palette === choice ? "selected" : ""}`} onClick={() => changePalette(choice)} aria-label={`Use ${choice} palette`} />)}
            </div>
            <button className={`status ${ready ? "ready" : "offline"}`} onClick={refreshStatus}>
              <span /> {ready ? `${status.configuredModel} ready` : status?.available ? "Model not installed" : "Ollama offline"}
            </button>
          </div>
        </header>

        <div className="messages">
          {messages.length === 0 && (
            <section className="welcome-state" aria-labelledby="welcome-title">
              <div className="ranga-scene" aria-hidden="true"><span className="butterfly one">◆</span><span className="butterfly two">◆</span><div className="welcome-orbit" /></div>
              <span className="welcome-kicker">{welcomeLines[welcomeIndex].kind}</span>
              <h2 id="welcome-title">A fresh conversation</h2>
              <blockquote>“{welcomeLines[welcomeIndex].text}”</blockquote>
              <cite>— {welcomeLines[welcomeIndex].credit}</cite>
              <div className="starter-grid" aria-label="Conversation starters">
                <button type="button" onClick={() => chooseStarter("Help me think through an idea: ")}>
                  <span className="starter-icon idea" aria-hidden="true">✦</span>
                  <span><strong>Explore an idea</strong><small>Brainstorm it locally</small></span>
                  <i aria-hidden="true">›</i>
                </button>
                <button type="button" onClick={() => chooseStarter("Help me with this coding task: ")}>
                  <span className="starter-icon code" aria-hidden="true">⌘</span>
                  <span><strong>Build something</strong><small>Plan or improve code</small></span>
                  <i aria-hidden="true">›</i>
                </button>
              </div>
            </section>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""} ${message.active ? "thinking" : ""}`}>
              {message.role === "assistant" && <div className={`avatar ${message.active ? "active" : ""}`} aria-hidden="true" />}
              <div className="message-body">
                {message.replyTo && <div className="reply-reference"><strong>{message.replyTo.role === "assistant" ? "Rangabot" : "You"}</strong><span>{message.replyTo.excerpt}</span></div>}
                {message.source && <span className="source">LOCAL</span>}
                {message.content && (message.role === "assistant"
                  ? <MarkdownMessage content={message.content} />
                  : <p>{message.content}</p>)}
                {message.active && (
                  <div className="message-activity" role="status" aria-label="Rangabot is thinking">
                    <span className="thinking-runner" aria-hidden="true"><i /></span>
                    <span>Thinking</span>
                  </div>
                )}
                {message.stopped && (
                  <div className="stopped-state" role="status"><i aria-hidden="true" /> Stopped</div>
                )}
                {!message.active && !message.error && <button type="button" className="reply-button" onClick={() => { setReplyTo(message); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); }} aria-label="Reply to this message">↩ <span>Reply</span></button>}
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
            {replyTo && <div className="composer-reply"><span><strong>Replying to {replyTo.role === "assistant" ? "Rangabot" : "your message"}</strong>{replyTo.content.slice(0, 100)}</span><button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div>}
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
                <option value="codex">Codex</option>
              </select>
              <span className="route-note">{mode === "codex" ? "Cloud handoff not enabled" : "Stays on this computer"}</span>
              {sending ? (
                <button className="stop-button" type="button" onClick={stopGenerating} aria-label="Stop generating">■</button>
              ) : (
                <button type="submit" disabled={!input.trim()} aria-label="Send">↑</button>
              )}
            </div>
          </form>
          <small>Local models can make mistakes. Review important code and decisions.</small>
        </div>
      </section>
    </main>
  );
}
