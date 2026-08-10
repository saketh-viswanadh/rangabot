"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { localApiFetch } from "@/lib/local-api-client";
import { CraftIcon } from "./craft-icon";

type MemoryKind = "preference" | "fact" | "instruction";
type LocalMemory = { id: string; content: string; kind: MemoryKind; origin: "user-approved"; confidence: 1; createdAt: string; updatedAt: string };
type MemoryImportItem = { sourceId: string; content: string; kind: MemoryKind };
type MemoryImportPreview = {
  newItems: MemoryImportItem[];
  duplicates: Array<{ incoming: MemoryImportItem; existing: LocalMemory }>;
  conflicts: Array<{ incoming: MemoryImportItem; existing: LocalMemory; reason: "same-id" | "different-kind" | "same-subject" }>;
};

export function MemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [memories, setMemories] = useState<LocalMemory[]>([]);
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [importPayload, setImportPayload] = useState<unknown>(null);
  const [importPreview, setImportPreview] = useState<MemoryImportPreview | null>(null);
  const [replaceSourceIds, setReplaceSourceIds] = useState<string[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const response = await localApiFetch("/api/memories", { cache: "no-store" });
    if (response.ok) setMemories(((await response.json()) as { memories: LocalMemory[] }).memories);
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void localApiFetch("/api/memories", { cache: "no-store", signal: controller.signal }).then(async (response) => {
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
    const response = await localApiFetch(editingId ? `/api/memories/${editingId}` : "/api/memories", {
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
    const response = await localApiFetch(`/api/memories/${id}`, { method: "DELETE" });
    if (response.ok) { if (editingId === id) { setEditingId(null); setContent(""); } await refresh(); }
  }

  async function previewImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 300_000) { setMessage("Memory import exceeds the 300 KB limit."); return; }
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const response = await localApiFetch("/api/memories/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", export: payload }) });
      const data = await response.json() as { preview?: MemoryImportPreview; error?: string };
      if (!response.ok || !data.preview) throw new Error(data.error ?? "Could not review the memory import.");
      setImportPayload(payload); setImportPreview(data.preview); setReplaceSourceIds([]);
      setMessage("Review complete. Nothing has been imported yet.");
    } catch (error) {
      setImportPayload(null); setImportPreview(null); setReplaceSourceIds([]);
      setMessage(error instanceof Error ? error.message : "Memory import failed.");
    }
  }

  function toggleReplacement(sourceId: string) {
    setReplaceSourceIds((current) => current.includes(sourceId) ? current.filter((id) => id !== sourceId) : [...current, sourceId]);
  }

  async function applyImport() {
    if (!importPreview || !importPayload) return;
    const response = await localApiFetch("/api/memories/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "apply", export: importPayload, replaceSourceIds }) });
    const data = await response.json() as { result?: { imported: number; replaced: number; skippedDuplicates: number; keptExisting: number }; error?: string };
    if (!response.ok || !data.result) { setMessage(data.error ?? "Memory import failed."); return; }
    setMessage(`Imported ${data.result.imported}, replaced ${data.result.replaced}, skipped ${data.result.skippedDuplicates} duplicate${data.result.skippedDuplicates === 1 ? "" : "s"}, and kept ${data.result.keptExisting} existing.`);
    setImportPayload(null); setImportPreview(null); setReplaceSourceIds([]);
    await refresh();
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
        <input ref={importRef} className="memory-import-input" type="file" accept="application/json,.json" onChange={(event) => void previewImport(event)} />
        {importPreview && <section className="memory-import-review" aria-label="Memory import review">
          <header><div><strong>Review import</strong><small>Nothing changes until you approve below.</small></div><button type="button" onClick={() => { setImportPayload(null); setImportPreview(null); setReplaceSourceIds([]); }}>Cancel</button></header>
          <div className="memory-import-counts"><span><b>{importPreview.newItems.length}</b> new</span><span><b>{importPreview.duplicates.length}</b> duplicates</span><span><b>{importPreview.conflicts.length}</b> conflicts</span></div>
          {!!importPreview.newItems.length && <div className="memory-import-group"><strong>New memories</strong>{importPreview.newItems.map((item) => <p key={item.sourceId}><span>{item.kind}</span>{item.content}</p>)}</div>}
          {!!importPreview.duplicates.length && <div className="memory-import-group muted"><strong>Duplicates · skipped</strong>{importPreview.duplicates.map(({ incoming }) => <p key={incoming.sourceId}><span>{incoming.kind}</span>{incoming.content}</p>)}</div>}
          {!!importPreview.conflicts.length && <div className="memory-import-group conflicts"><strong>Conflicts · existing wins by default</strong>{importPreview.conflicts.map((conflict) => <label key={conflict.incoming.sourceId}><input type="checkbox" checked={replaceSourceIds.includes(conflict.incoming.sourceId)} onChange={() => toggleReplacement(conflict.incoming.sourceId)} /><span><small>Keep existing</small>{conflict.existing.content}<small>Use imported instead</small>{conflict.incoming.content}</span></label>)}</div>}
          <button className="memory-import-apply" type="button" onClick={() => void applyImport()} disabled={!importPreview.newItems.length && !replaceSourceIds.length}>Approve reviewed import</button>
        </section>}
        <section className="memory-list" aria-label="Approved local memories"><header><strong>Approved memories</strong><div><span>{memories.length}</span><button type="button" onClick={() => importRef.current?.click()}>Import JSON</button><a href="/api/memories/export" download>Export JSON</a></div></header>{!memories.length && <p>Nothing saved yet. Rangabot will not invent a profile for you.</p>}{memories.map((memory) => <article key={memory.id}><div><span>{memory.kind}</span><small>User approved · explicit confidence</small></div><p>{memory.content}</p><footer><time>{new Date(memory.updatedAt).toLocaleDateString()}</time><button type="button" onClick={() => edit(memory)}><CraftIcon name="edit" size={13} /> Edit</button><button type="button" onClick={() => void remove(memory.id)}><CraftIcon name="trash" size={13} /> Delete</button></footer></article>)}</section>
      </div>
    </aside>
  </div>;
}
