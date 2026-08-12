"use client";

import { useEffect, useState } from "react";
import { localApiFetch } from "@/lib/local-api-client";

type Model = { id: string; label: string; installed: boolean; selected: boolean; recommended: boolean; tier?: string; downloadSize?: string; minimumMemoryGb?: number; uses?: readonly string[] };
type ModelState = { preference: { selectedModel: string; revision: number }; models: Model[] };

export function ModelManager({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const [state, setState] = useState<ModelState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading local models…");

  useEffect(() => {
    let active = true;
    void localApiFetch("/api/models", { cache: "no-store" }).then(async (response) => {
      const data = await response.json() as ModelState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Model manager unavailable.");
      if (active) { setState(data); setMessage(""); }
    }).catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Model manager unavailable."); });
    return () => { active = false; };
  }, []);

  async function install(model: Model) {
    setBusy(model.id);
    setMessage(`Downloading ${model.label}. Keep RangaBot open…`);
    try {
      const response = await localApiFetch("/api/models/install", { method: "POST", body: JSON.stringify({ modelId: model.id, confirmed: true }) });
      const data = await response.json() as ModelState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Download failed.");
      setState(data);
      setMessage(`${model.label} is installed locally.`);
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Download failed."); }
    finally { setBusy(null); }
  }

  async function select(model: Model) {
    if (!state) return;
    setBusy(model.id);
    try {
      const response = await localApiFetch("/api/models", { method: "PUT", body: JSON.stringify({ modelId: model.id, expectedRevision: state.preference.revision }) });
      const data = await response.json() as ModelState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Selection failed.");
      setState(data);
      setMessage(`${model.label} is now the general model.`);
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Selection failed."); }
    finally { setBusy(null); }
  }

  return <div className="welcome-preferences-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="model-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
      <header><div><span>Private local intelligence</span><h2 id="model-manager-title">Model Manager</h2></div><button type="button" onClick={onClose} aria-label="Close model manager">×</button></header>
      <div className="model-manager-intro"><strong>RangaBot runs these models itself.</strong><p>No terminal or separate Ollama app is required. Model files stay inside RangaBot’s private local storage.</p></div>
      <div className="model-manager-list">
        {state?.models.map((model) => <article key={model.id} className={model.selected ? "selected" : ""}>
          <div><strong>{model.label}</strong><small>{model.tier ?? "Custom installed model"}{model.downloadSize ? ` · ${model.downloadSize}` : ""}{model.minimumMemoryGb ? ` · ${model.minimumMemoryGb} GB+ RAM` : ""}</small>{model.uses && <p>{model.uses.join(" · ")}</p>}</div>
          {model.installed
            ? <button type="button" disabled={model.selected || busy !== null} onClick={() => void select(model)}>{model.selected ? "Selected" : "Use model"}</button>
            : <button type="button" disabled={busy !== null} onClick={() => void install(model)}>{busy === model.id ? "Downloading…" : "Install"}</button>}
        </article>)}
      </div>
      <footer><p role="status">{message || "Downloads require your click and may use several gigabytes."}</p><button type="button" onClick={onClose}>Done</button></footer>
    </section>
  </div>;
}
