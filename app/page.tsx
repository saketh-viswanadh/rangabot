"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { ChatMessage, ProviderStatus } from "@/lib/providers/types";

type Mode = "local" | "smart" | "codex";
type DisplayMessage = ChatMessage & { id: string; source?: "local"; error?: boolean };

const welcome: DisplayMessage = {
  id: "welcome",
  role: "assistant",
  content: "I’m Rangabot, your local-first assistant. Coding and brainstorming stay on this computer. Cloud handoff is not enabled yet.",
  source: "local",
};

export default function Home() {
  const [messages, setMessages] = useState<DisplayMessage[]>([welcome]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("smart");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [sending, setSending] = useState(false);
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

  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    const userMessage: DisplayMessage = { id: crypto.randomUUID(), role: "user", content };
    const assistantId = crypto.randomUUID();
    const nextMessages = [...messages.filter((message) => message.id !== "welcome"), userMessage];
    setMessages((current) => [...current, userMessage, {
      id: assistantId,
      role: "assistant",
      content: "",
      source: "local",
    }]);
    setInput("");
    setSending(true);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          mode,
          messages: nextMessages.map(({ role, content: text }) => ({ role, content: text })),
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
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content + chunk } : message
        )));
      }
      const finalChunk = decoder.decode();
      if (finalChunk) {
        receivedContent = true;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content + finalChunk } : message
        )));
      }
      if (!receivedContent) throw new Error("The local model returned an empty response.");
    } catch (error) {
      const stopped = abortController.signal.aborted;
      setMessages((current) => current.map((message) => {
        if (message.id !== assistantId) return message;
        if (stopped) {
          return {
            ...message,
            content: message.content
              ? `${message.content}\n\n[Generation stopped]`
              : "[Generation stopped]",
          };
        }
        return {
          ...message,
          content: error instanceof Error ? error.message : "The request failed.",
          error: true,
          source: undefined,
        };
      }));
      if (!stopped) void refreshStatus();
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  function stopGenerating() {
    abortRef.current?.abort();
  }

  const ready = status?.available && status.modelInstalled;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">R</span><span>Rangabot</span></div>
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
          <div><h1>Rangabot</h1><p>Code, think, and build privately</p></div>
          <button className={`status ${ready ? "ready" : "offline"}`} onClick={refreshStatus}>
            <span /> {ready ? `${status.configuredModel} ready` : status?.available ? "Model not installed" : "Ollama offline"}
          </button>
        </header>

        <div className="messages">
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""}`}>
              {message.role === "assistant" && <div className="avatar">R</div>}
              <div className="message-body">
                {message.source && <span className="source">LOCAL</span>}
                <p>{message.content}</p>
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
