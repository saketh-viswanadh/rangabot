"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { CraftIcon } from "./craft-icon";

type MemoryKind = "preference" | "fact" | "instruction";
type LocalMemory = { id: string; content: string; kind: MemoryKind; origin: "user-approved"; confidence: 1; createdAt: string; updatedAt: string };

export function MemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [memories, setMemories] = useState<LocalMemory[]>([]);
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  async function refresh() {
    const response = await fetch("/api/memories", { cache: "no-store" });
    if (response.ok) setMemories(((await response.json()) as { memories: LocalMemory[] }).memories);
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/memories", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (response.ok) setMemories(((await response.json()) as { memories: LocalMemory[] }).memories);
    }).catch(() => undefined);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => { controller.abort(); document.removeEventListener("keydown", closeOnEscape); };
  }, [open, onClose]);

  if (!open) return null;

  async function save(event: FormEvent) {
    event.preventDefault();
    const response = await fetch(editingId ? `/api/memories/${editingId}` : "/api/memories", {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, kind }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setMessage(data.error ?? "Could not save memory."); return; }
    setContent(""); setKind("preference"); setEditingId(null); setMessage("Saved locally with your approval.");
    await refresh();
  }

  function edit(memory: LocalMemory) { setEditingId(memory.id); setContent(memory.content); setKind(memory.kind); setMessage(""); }

  async function remove(id: string) {
    const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    if (response.ok) { if (editingId === id) { setEditingId(null); setContent(""); } await refresh(); }
  }

  return <div className="knowledge-backdrop" onMouseDown={onClose}>
    <aside className="memory-panel" role="dialog" aria-modal="true" aria-labelledby="memory-panel-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="knowledge-panel-header"><div><span>Private · user approved</span><h2 id="memory-panel-title">Local memory</h2></div><button type="button" ref={closeRef} onClick={onClose} aria-label="Close local memory"><CraftIcon name="close" /></button></div>
      <div className="memory-panel-content">
        <section className="memory-intro"><CraftIcon name="memory" size={24} /><div><strong>Rangabot remembers only what you save here.</strong><p>Every item is visible, editable and deletable. Saved items are supplied to the local model as user-provided context—not verified truth.</p></div></section>
        <form className="memory-form" onSubmit={save}>
          <label><span>What should Ranga remember?</span><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={500} rows={3} placeholder="For example: Prefer concise answers with a practical example." required /></label>
          <div><label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}><option value="preference">Preference</option><option value="fact">Fact I provided</option><option value="instruction">Standing instruction</option></select></label><button type="submit">{editingId ? "Update memory" : "Approve and remember"}</button></div>
          <small>{content.length}/500 · Origin: user approved · Confidence: explicit</small>{message && <p role="status">{message}</p>}
        </form>
        <section className="memory-list" aria-label="Approved local memories"><header><strong>Approved memories</strong><div><span>{memories.length}</span><a href="/api/memories/export" download>Export JSON</a></div></header>{!memories.length && <p>Nothing saved yet. Rangabot will not invent a profile for you.</p>}{memories.map((memory) => <article key={memory.id}><div><span>{memory.kind}</span><small>User approved · explicit confidence</small></div><p>{memory.content}</p><footer><time>{new Date(memory.updatedAt).toLocaleDateString()}</time><button type="button" onClick={() => edit(memory)}><CraftIcon name="edit" size={13} /> Edit</button><button type="button" onClick={() => void remove(memory.id)}><CraftIcon name="trash" size={13} /> Delete</button></footer></article>)}</section>
      </div>
    </aside>
  </div>;
}
