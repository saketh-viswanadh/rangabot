"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CraftIcon } from "@/app/components/craft-icon";
import { localApiFetch } from "@/lib/local-api-client";
import { formatSqlCell } from "@/lib/sql-display";
import type { AttachedDataset, SqlDraft } from "@/lib/sql-display";

type Dataset = { id: string; name: string; format: "csv" | "parquet" | "duckdb"; sizeBytes: number; addedAt: string };
type Preview = { confirmationId: string; token: string; expiresAt: string; dataset: { id: string; name: string; format: string; sizeBytes: number; sha256: string }; query: string; limits: { readOnly: true; externalAccess: false; maxRows: number; timeoutMs: number } };
type Result = { columns: string[]; rows: unknown[][]; receipt: { engine: "duckdb"; input: { filename: string; sha256: string; sizeBytes: number }; querySha256: string; rowLimit: number; returnedRows: number; truncated: boolean; durationMs: number } };
type DesktopFilePickerBridge = { pickLocalFiles(kind: "knowledge" | "dataset"): Promise<{ status: "selected" | "cancelled"; paths: string[] }> };

export function SqlAnalysisPanel({ open, onClose, onAttach, initialDraft, activeProfileMarker }: { open: boolean; onClose: () => void; onAttach: (dataset: AttachedDataset) => void; initialDraft?: SqlDraft | null; activeProfileMarker: string }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetPath, setDatasetPath] = useState("");
  const [datasetId, setDatasetId] = useState(initialDraft?.datasetId ?? "");
  const [query, setQuery] = useState(initialDraft?.query ?? "SELECT * FROM dataset LIMIT 20");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const response = await localApiFetch("/api/datasets", { cache: "no-store" });
    const data = (await response.json()) as { datasets?: Dataset[]; error?: string };
    if (!response.ok || !data.datasets) return setMessage(data.error ?? "Could not read approved datasets.");
    setDatasets(data.datasets);
    setDatasetId((current) => data.datasets?.some((dataset) => dataset.id === current) ? current : data.datasets?.[0]?.id ?? "");
  }, []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => { void refresh(); closeRef.current?.focus(); });
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, refresh]);

  async function approve(event: FormEvent) {
    event.preventDefault();
    if (!datasetPath.trim()) return;
    setBusy(true); setMessage("");
    const response = await localApiFetch("/api/datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: datasetPath.trim() }) });
    const data = (await response.json()) as { dataset?: Dataset; error?: string };
    setBusy(false);
    if (!response.ok || !data.dataset) return setMessage(data.error ?? "Could not approve this dataset.");
    setDatasetPath(""); setDatasetId(data.dataset.id); setMessage(`${data.dataset.name} is approved locally.`); setPreview(null); setResult(null);
    await refresh();
  }

  async function chooseDataset() {
    const desktop = (window as typeof window & { rangabotDesktop?: DesktopFilePickerBridge }).rangabotDesktop;
    if (!desktop) return setMessage("Use the RangaBot desktop app to choose a local data file without typing its path.");
    const selection = await desktop.pickLocalFiles("dataset");
    if (selection.status === "selected" && selection.paths[0]) {
      setDatasetPath(selection.paths[0]);
      setMessage(`${selection.paths[0].split(/[\\/]/).at(-1)} selected. Press Allow to grant read-only access.`);
    }
  }

  async function revoke(dataset: Dataset) {
    const response = await localApiFetch(`/api/datasets/${dataset.id}`, { method: "DELETE" });
    if (!response.ok) return setMessage("Could not revoke this dataset.");
    if (datasetId === dataset.id) { setDatasetId(""); setPreview(null); setResult(null); }
    setMessage(`${dataset.name} approval was revoked. The file was not changed.`);
    await refresh();
  }

  async function createPreview(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(""); setPreview(null); setResult(null);
    const response = await localApiFetch("/api/analysis/sql/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, query }) });
    const data = (await response.json()) as { preview?: Preview; error?: string }; setBusy(false);
    if (!response.ok || !data.preview) return setMessage(data.error ?? "Could not create the SQL proposal.");
    setPreview(data.preview);
  }

  async function runOnce() {
    if (!preview) return;
    setBusy(true); setMessage("");
    const response = await localApiFetch("/api/analysis/sql/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationId: preview.confirmationId, token: preview.token, datasetId: preview.dataset.id, query: preview.query }) });
    const data = (await response.json()) as { result?: Result; error?: string }; setBusy(false); setPreview(null);
    if (!response.ok || !data.result) return setMessage(data.error ?? "The SQL execution failed.");
    setResult(data.result); setMessage("Completed locally. The one-time approval has been consumed.");
  }

  if (!open) return null;
  return <div className="knowledge-backdrop" onMouseDown={onClose}><aside className="sql-panel" role="dialog" aria-modal="true" aria-labelledby="sql-panel-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="knowledge-panel-header"><div><span>Private local analysis</span><h2 id="sql-panel-title">SQL workspace</h2><small>Active profile: {activeProfileMarker}</small><small>Nothing runs until you approve the exact query.</small></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close SQL workspace"><CraftIcon name="close" /></button></div>
    <div className="sql-panel-content"><section className="sql-datasets"><header><div><strong>Approved data</strong><small>CSV, Parquet or DuckDB · 100 MB maximum</small></div><span>{datasets.length}</span></header>
      <div className="sql-dataset-list">{datasets.map((dataset) => <div key={dataset.id} className={dataset.id === datasetId ? "selected" : ""}><button type="button" onClick={() => { setDatasetId(dataset.id); setPreview(null); setResult(null); }}><strong>{dataset.name}</strong><small>{dataset.format.toUpperCase()} · {(dataset.sizeBytes / 1024 ** 2).toFixed(1)} MB</small></button><button type="button" onClick={() => void revoke(dataset)} aria-label={`Revoke ${dataset.name}`}><CraftIcon name="close" size={13} /></button></div>)}</div>
      {datasetId && <button type="button" className="sql-attach" onClick={() => { const dataset = datasets.find((item) => item.id === datasetId); if (dataset) { onAttach(dataset); onClose(); } }}>Use selected data in chat</button>}
      <form className="sql-allow-form" onSubmit={approve}><button type="button" className="sql-file-picker" onClick={() => void chooseDataset()}><CraftIcon name="document" size={15} /> Choose data file</button>{datasetPath && <span title={datasetPath}>{datasetPath.split(/[\\/]/).at(-1)}</span>}<button type="submit" disabled={busy || !datasetPath.trim()}>Allow read-only</button></form><p>Approval stores only the local path. Revoking never deletes the file.</p>
    </section><section className="sql-workbench"><form className="sql-query-form" onSubmit={createPreview}><label htmlFor="sql-query">Exact read-only query</label><textarea id="sql-query" value={query} onChange={(event) => { setQuery(event.target.value); setPreview(null); setResult(null); }} rows={7} spellCheck={false} /><button type="submit" disabled={busy || !datasetId || !query.trim()}>{busy ? "Preparing…" : "Review query"}</button></form>
      {preview && <article className="sql-proposal" aria-label="SQL execution proposal"><header><div><span>Approval required</span><strong>{preview.dataset.name}</strong></div><time dateTime={preview.expiresAt}>Expires {new Date(preview.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header><pre><code>{preview.query}</code></pre><dl><div><dt>Access</dt><dd>Read only · external access off</dd></div><div><dt>Limits</dt><dd>{preview.limits.maxRows} rows · {preview.limits.timeoutMs / 1000}s</dd></div><div><dt>Dataset fingerprint</dt><dd>{preview.dataset.sha256.slice(0, 12)}…</dd></div></dl><footer><button type="button" className="sql-reject" onClick={() => { setPreview(null); setMessage("Proposal rejected. Nothing was executed."); }}>Reject</button><button type="button" className="sql-run" disabled={busy} onClick={() => void runOnce()}>{busy ? "Running…" : "Run once"}</button></footer></article>}
      {result && <article className="sql-result"><header><div><span>Verified local result</span><strong>{result.receipt.returnedRows} row{result.receipt.returnedRows === 1 ? "" : "s"}{result.receipt.truncated ? " · truncated" : ""}</strong></div><small>{result.receipt.durationMs} ms · DuckDB</small></header><div className="sql-result-table"><table><thead><tr>{result.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{formatSqlCell(cell)}</td>)}</tr>)}</tbody></table></div><details><summary>Execution receipt</summary><code>input {result.receipt.input.sha256}</code><code>query {result.receipt.querySha256}</code></details></article>}
      {!preview && !result && <div className="sql-empty"><CraftIcon name="analysis" size={24} /><strong>Prepare, inspect, then run</strong><p>Select an approved dataset and write one SELECT query. Chat messages and model output can never trigger execution.</p></div>}{message && <p className="sql-status" role="status">{message}</p>}
    </section></div>
  </aside></div>;
}
