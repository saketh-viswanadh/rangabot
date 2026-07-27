"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { ChatMessage, ProviderStatus } from "@/lib/providers/types";

type Mode = "local" | "smart" | "codex";
type DisplayMessage = ChatMessage & { id: string; source?: "local"; error?: boolean };

const welcome: DisplayMessage = {
  id: "welcome",
  role: "assistant",
  content: "I’m your local-first assistant. Coding and brainstorming stay on this computer. Cloud handoff is not enabled yet.",
  source: "local",
};

export default function Home() {
  const [messages, setMessages] = useState<DisplayMessage[]>([welcome]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("smart");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      setStatus(await response.json());
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    const userMessage: DisplayMessage = { id: crypto.randomUUID(), role: "user", content };
    const nextMessages = [...messages.filter((message) => message.id !== "welcome"), userMessage];
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          messages: nextMessages.map(({ role, content: text }) => ({ role, content: text })),
        }),
      });
      const data = (await response.json()) as { content?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.content ?? "",
        source: "local",
      }]);
    } catch (error) {
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: error instanceof Error ? error.message : "The request failed.",
        error: true,
      }]);
      void refreshStatus();
    } finally {
      setSending(false);
    }
  }

  const ready = status?.available && status.modelInstalled;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">W</span><span>Wan</span></div>
        <button className="new-chat" onClick={() => setMessages([welcome])}>＋ New chat</button>
        <nav>
          <span className="nav-label">Workspace</span>
          <button className="nav-item active">Chat</button>
          <button className="nav-item" disabled>Projects <em>Soon</em></button>
          <button className="nav-item" disabled>Models <em>Soon</em></button>
          <button className="nav-item" disabled>Tools <em>Soon</em></button>
        </nav>
        <div className="privacy-card">
          <span className="shield">◆</span>
          <div><strong>Private by default</strong><p>Nothing is sent to the cloud in this milestone.</p></div>
        </div>
      </aside>

      <section className="chat-panel">
        <header>
          <div><h1>Local assistant</h1><p>Code, think, and build privately</p></div>
          <button className={`status ${ready ? "ready" : "offline"}`} onClick={refreshStatus}>
            <span /> {ready ? `${status.configuredModel} ready` : status?.available ? "Model not installed" : "Ollama offline"}
          </button>
        </header>

        <div className="messages">
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""}`}>
              {message.role === "assistant" && <div className="avatar">W</div>}
              <div className="message-body">
                {message.source && <span className="source">LOCAL</span>}
                <p>{message.content}</p>
              </div>
            </article>
          ))}
          {sending && <article className="message assistant"><div className="avatar">W</div><div className="typing"><i /><i /><i /></div></article>}
          <div ref={endRef} />
        </div>

        <div className="composer-wrap">
          {!ready && <div className="setup-hint">
            <strong>{status?.available ? "Install the configured model" : "Start Ollama to chat"}</strong>
            <span>{status?.available ? `Run: ollama pull ${status.configuredModel}` : "The app is ready and waiting for the local model service."}</span>
          </div>}
          <form className="composer" onSubmit={sendMessage}>
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
              <button type="submit" disabled={!input.trim() || sending} aria-label="Send">↑</button>
            </div>
          </form>
          <small>Local models can make mistakes. Review important code and decisions.</small>
        </div>
      </section>
    </main>
  );
}
