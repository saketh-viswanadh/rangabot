"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CraftIcon } from "@/app/components/craft-icon";
import { localApiFetch } from "@/lib/local-api-client";
import { formatSqlCell } from "@/lib/sql-display";
import type { AttachedDataset, SqlDraft } from "@/lib/sql-display";

type Dataset = { id: string; name: string; format: "csv" | "parquet" | "duckdb"; sizeBytes: number; addedAt: string };
type Preview = { confirmationId: string; token: string; expiresAt: string; dataset: { id: string; name: string; format: string; sizeBytes: number; sha256: string }; query: string; limits: { readOnly: true; externalAccess: false; maxRows: number; timeoutMs: number } };
type Result = { columns: string[]; rows: unknown[][]; receipt: { engine: "duckdb"; input: { filename: string; sha256: string; sizeBytes: number }; querySha256: string; readOnly: true; externalAccess: false; rowLimit: number; returnedRows: number; truncated: boolean; durationMs: number } };
type DesktopFilePickerBridge = { pickLocalFiles(kind: "knowledge" | "dataset"): Promise<{ status: "selected" | "cancelled"; paths: string[] }> };
type SemanticContext = { version: 1; tables?: Array<{ table: string; description?: string; aliases?: string[] }>; columns?: Array<{ table: string; column: string; description?: string; aliases?: string[] }>; relationships?: Array<{ fromTable: string; fromColumn: string; toTable: string; toColumn: string; confirmed: true }> };
type ContextPayload = { dataset: { id: string; name: string }; tables: Array<{ table: string; columns: Array<{ name: string; type: string }> }>; memory: { revision: number; status: "not-started" | "skipped" | "complete"; updatedAt?: string; context: SemanticContext; learnedUsage: { tables: number; columns: number } } };
type DatasetRevocationBindingResult = "detached" | "not-bound" | "unconfirmed";

function aliases(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function isDataset(value: unknown): value is Dataset {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Dataset>;
  return typeof item.id === "string" && typeof item.name === "string"
    && (item.format === "csv" || item.format === "parquet" || item.format === "duckdb")
    && typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes) && typeof item.addedAt === "string";
}
function isDatasetList(value: unknown): value is Dataset[] { return Array.isArray(value) && value.every(isDataset); }

function isPreview(value: unknown, datasetId: string, requestedQuery: string): value is Preview {
  if (!record(value) || !record(value.dataset) || !record(value.limits)) return false;
  const dataset = value.dataset;
  const limits = value.limits;
  const normalizedQuery = requestedQuery.trim().replace(/;\s*$/, "");
  return typeof value.confirmationId === "string" && value.confirmationId.length > 0
    && typeof value.token === "string" && value.token.length > 0
    && typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt))
    && typeof value.query === "string" && value.query === normalizedQuery
    && dataset.id === datasetId && typeof dataset.name === "string" && dataset.name.length > 0
    && (dataset.format === "csv" || dataset.format === "parquet" || dataset.format === "duckdb")
    && Number.isSafeInteger(dataset.sizeBytes) && Number(dataset.sizeBytes) > 0
    && typeof dataset.sha256 === "string" && /^[a-f0-9]{64}$/.test(dataset.sha256)
    && limits.readOnly === true && limits.externalAccess === false
    && Number.isSafeInteger(limits.maxRows) && Number(limits.maxRows) > 0
    && Number.isSafeInteger(limits.timeoutMs) && Number(limits.timeoutMs) > 0;
}

function isResult(value: unknown, preview: Preview): value is Result {
  if (!record(value) || !Array.isArray(value.columns) || !value.columns.every((column) => typeof column === "string")
    || !Array.isArray(value.rows) || !record(value.receipt)) return false;
  const columns = value.columns;
  const rows = value.rows;
  const receipt = value.receipt;
  if (!record(receipt.input)) return false;
  const input = receipt.input;
  return rows.every((row) => Array.isArray(row) && row.length === columns.length)
    && receipt.engine === "duckdb"
    && input.filename === preview.dataset.name && input.sha256 === preview.dataset.sha256
    && input.sizeBytes === preview.dataset.sizeBytes
    && typeof receipt.querySha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.querySha256)
    && receipt.readOnly === true && receipt.externalAccess === false
    && receipt.rowLimit === preview.limits.maxRows
    && Number.isSafeInteger(receipt.returnedRows) && receipt.returnedRows === rows.length
    && typeof receipt.truncated === "boolean"
    && typeof receipt.durationMs === "number" && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0;
}

function isContextPayload(value: unknown): value is ContextPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ContextPayload>;
  const dataset = payload.dataset;
  const memory = payload.memory;
  return Boolean(dataset && typeof dataset.id === "string" && typeof dataset.name === "string"
    && Array.isArray(payload.tables) && payload.tables.every((table) => Boolean(table && typeof table.table === "string"
      && Array.isArray(table.columns) && table.columns.every((column) => Boolean(column && typeof column.name === "string" && typeof column.type === "string"))))
    && memory && Number.isSafeInteger(memory.revision) && memory.revision >= 0
    && (memory.status === "not-started" || memory.status === "skipped" || memory.status === "complete")
    && memory.context && memory.context.version === 1
    && (!memory.context.tables || Array.isArray(memory.context.tables))
    && (!memory.context.columns || Array.isArray(memory.context.columns))
    && (!memory.context.relationships || Array.isArray(memory.context.relationships))
    && memory.learnedUsage && Number.isSafeInteger(memory.learnedUsage.tables) && Number.isSafeInteger(memory.learnedUsage.columns));
}

function DatasetContextEditor({ payload, busy, status, onSave, onReload, onClose }: { payload: ContextPayload; busy: boolean; status: string; onSave: (status: "skipped" | "complete", context: SemanticContext) => Promise<void>; onReload: () => void; onClose: () => void }) {
  const initial = payload.memory.context;
  const [tableDescriptions, setTableDescriptions] = useState<Record<string, string>>(() => Object.fromEntries((initial.tables ?? []).map((item) => [item.table, item.description ?? ""])));
  const [tableAliases, setTableAliases] = useState<Record<string, string>>(() => Object.fromEntries((initial.tables ?? []).map((item) => [item.table, (item.aliases ?? []).join(", ")])));
  const [columnDescriptions, setColumnDescriptions] = useState<Record<string, string>>(() => Object.fromEntries((initial.columns ?? []).map((item) => [`${item.table}.${item.column}`, item.description ?? ""])));
  const [columnAliases, setColumnAliases] = useState<Record<string, string>>(() => Object.fromEntries((initial.columns ?? []).map((item) => [`${item.table}.${item.column}`, (item.aliases ?? []).join(", ")])));
  const fields = payload.tables.flatMap((table) => table.columns.map((column) => ({ value: JSON.stringify([table.table, column.name]), label: `${table.table}.${column.name}` })));
  const [relationships, setRelationships] = useState(() => initial.relationships ?? []);
  const [fromField, setFromField] = useState(fields[0]?.value ?? "");
  const [toField, setToField] = useState(fields[1]?.value ?? fields[0]?.value ?? "");

  function buildContext(): SemanticContext {
    return {
      version: 1,
      tables: payload.tables.flatMap(({ table }) => {
        const description = tableDescriptions[table]?.trim(); const names = aliases(tableAliases[table] ?? "");
        return description || names.length ? [{ table, ...(description ? { description } : {}), ...(names.length ? { aliases: names } : {}) }] : [];
      }),
      columns: payload.tables.flatMap(({ table, columns }) => columns.flatMap(({ name }) => {
        const key = `${table}.${name}`; const description = columnDescriptions[key]?.trim(); const names = aliases(columnAliases[key] ?? "");
        return description || names.length ? [{ table, column: name, ...(description ? { description } : {}), ...(names.length ? { aliases: names } : {}) }] : [];
      })),
      relationships,
    };
  }

  function addRelationship() {
    const [fromTable, fromColumn] = JSON.parse(fromField) as [string, string]; const [toTable, toColumn] = JSON.parse(toField) as [string, string];
    const relationship = { fromTable, fromColumn, toTable, toColumn, confirmed: true as const };
    if (fromField !== toField && !relationships.some((item) => item.fromTable === fromTable && item.fromColumn === fromColumn && item.toTable === toTable && item.toColumn === toColumn)) setRelationships([...relationships, relationship]);
  }

  return <div className="sql-context-backdrop" onMouseDown={() => { if (!busy) onClose(); }}><section className="sql-context-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-context-title" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span>Optional · saved only in this profile</span><h3 id="dataset-context-title">Teach Ranga about {payload.dataset.name}</h3><p>Do this once, then edit whenever your definitions change. Ranga learns which fields you use after verified queries, but never invents or silently changes their meaning.</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close dataset context"><CraftIcon name="close" /></button></header>
    <div className="sql-context-content" inert={busy}>
      {payload.tables.map(({ table, columns }) => <details key={table} open={payload.tables.length <= 4}><summary><strong>{table}</strong><small>{columns.length} columns</small></summary><div className="sql-context-table">
        <label>What does this table represent?<textarea value={tableDescriptions[table] ?? ""} onChange={(event) => setTableDescriptions({ ...tableDescriptions, [table]: event.target.value })} rows={2} placeholder="Example: One row per completed customer order" /></label>
        <label>Everyday names, comma-separated<input value={tableAliases[table] ?? ""} onChange={(event) => setTableAliases({ ...tableAliases, [table]: event.target.value })} placeholder="orders, purchases" /></label>
        <div className="sql-context-columns">{columns.map((column) => { const key = `${table}.${column.name}`; return <div key={key}><code>{column.name}</code><small>{column.type}</small><input aria-label={`Meaning of ${key}`} value={columnDescriptions[key] ?? ""} onChange={(event) => setColumnDescriptions({ ...columnDescriptions, [key]: event.target.value })} placeholder="Meaning (optional)" /><input aria-label={`Aliases for ${key}`} value={columnAliases[key] ?? ""} onChange={(event) => setColumnAliases({ ...columnAliases, [key]: event.target.value })} placeholder="Aliases, comma-separated" /></div>; })}</div>
      </div></details>)}
      {fields.length > 1 && <section className="sql-context-relationships"><header><div><strong>Confirmed join keys</strong><small>Add only relationships you know are correct.</small></div></header><div><select value={fromField} onChange={(event) => setFromField(event.target.value)}>{fields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select><span>matches</span><select value={toField} onChange={(event) => setToField(event.target.value)}>{fields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select><button type="button" onClick={addRelationship}>Add</button></div>{relationships.map((item, index) => <p key={`${item.fromTable}.${item.fromColumn}-${item.toTable}.${item.toColumn}`}><code>{item.fromTable}.{item.fromColumn}</code> = <code>{item.toTable}.{item.toColumn}</code><button type="button" onClick={() => setRelationships(relationships.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></p>)}</section>}
    </div>
    {status && <div className="sql-context-status" role="status" aria-live="polite"><span>{status}</span><button type="button" disabled={busy} onClick={onReload}>Reload saved context</button></div>}
    <footer><button type="button" className="sql-context-skip" disabled={busy} onClick={() => payload.memory.status === "complete" ? onClose() : void onSave("skipped", { version: 1 })}>{payload.memory.status === "complete" ? "Close without changes" : "Skip for now"}</button><button type="button" disabled={busy} onClick={() => void onSave("complete", buildContext())}>{busy ? "Saving…" : "Save local context"}</button></footer>
  </section></div>;
}

export function SqlAnalysisPanel({ open, onClose, onAttach, onDatasetRevoked, initialDraft, activeProfileMarker }: { open: boolean; onClose: () => void; onAttach: (dataset: AttachedDataset) => void; onDatasetRevoked?: (datasetId: string) => Promise<DatasetRevocationBindingResult> | DatasetRevocationBindingResult; initialDraft?: SqlDraft | null; activeProfileMarker: string }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetPath, setDatasetPath] = useState("");
  const [datasetId, setDatasetId] = useState(initialDraft?.datasetId ?? "");
  const [query, setQuery] = useState(initialDraft?.query ?? "SELECT * FROM dataset LIMIT 20");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceProfileMarker, setWorkspaceProfileMarker] = useState("");
  const [contextPayload, setContextPayload] = useState<ContextPayload | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextMessage, setContextMessage] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const workspaceRequestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const analysisRequestRef = useRef(0);
  const workspaceMutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceCurrent = workspaceReady && workspaceProfileMarker === activeProfileMarker;
  function trackWorkspaceMutation<T>(request: Promise<T>) {
    const settled = request.then(() => undefined, () => undefined);
    workspaceMutationTailRef.current = Promise.all([workspaceMutationTailRef.current, settled]).then(() => undefined);
    return request;
  }
  const closePanel = useCallback(() => {
    workspaceRequestRef.current += 1;
    contextRequestRef.current += 1;
    analysisRequestRef.current += 1;
    setWorkspaceReady(false); setWorkspaceProfileMarker("");
    setContextOpen(false);
    setContextPayload(null);
    setContextMessage("");
    setPreview(null); setResult(null);
    onClose();
  }, [onClose]);

  const refresh = useCallback(async (
    workspaceRequest = workspaceRequestRef.current,
    failureMessage = "Could not refresh approved datasets. Close and reopen the SQL workspace to try again.",
  ) => {
    try {
      const response = await localApiFetch("/api/datasets", { cache: "no-store" });
      const data = (await response.json()) as { datasets?: unknown; error?: string };
      if (workspaceRequest !== workspaceRequestRef.current) return null;
      if (!response.ok || !isDatasetList(data.datasets)) {
        setDatasets([]); setDatasetId(""); setWorkspaceReady(false); setWorkspaceProfileMarker("");
        setMessage(data.error ?? failureMessage);
        return null;
      }
      const refreshedDatasets = data.datasets;
      setDatasets(refreshedDatasets);
      setDatasetId((current) => refreshedDatasets.some((dataset) => dataset.id === current) ? current : refreshedDatasets[0]?.id ?? "");
      setWorkspaceProfileMarker(activeProfileMarker); setWorkspaceReady(true);
      return refreshedDatasets;
    } catch {
      if (workspaceRequest === workspaceRequestRef.current) {
        setDatasets([]); setDatasetId(""); setWorkspaceReady(false); setWorkspaceProfileMarker(""); setMessage(failureMessage);
      }
      return null;
    }
  }, [activeProfileMarker]);

  useEffect(() => {
    if (!open) {
      const closedRequest = ++workspaceRequestRef.current;
      contextRequestRef.current += 1;
      analysisRequestRef.current += 1;
      queueMicrotask(() => {
        if (closedRequest !== workspaceRequestRef.current) return;
        setWorkspaceReady(false); setWorkspaceProfileMarker(""); setContextOpen(false); setContextPayload(null); setContextMessage(""); setPreview(null); setResult(null);
      });
      return;
    }
    const workspaceRequest = ++workspaceRequestRef.current;
    contextRequestRef.current += 1;
    analysisRequestRef.current += 1;
    requestAnimationFrame(() => {
      if (workspaceRequest !== workspaceRequestRef.current) return;
      setWorkspaceReady(false); setWorkspaceProfileMarker(""); setContextOpen(false); setContextPayload(null); setContextMessage(""); setPreview(null); setResult(null); setBusy(true); setMessage("Refreshing approved datasets…");
      void workspaceMutationTailRef.current.then(() => refresh(workspaceRequest)).then((refreshed) => {
        if (workspaceRequest !== workspaceRequestRef.current) return;
        setBusy(false);
        if (refreshed) setMessage("");
      });
      closeRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closePanel(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [activeProfileMarker, closePanel, open, refresh]);

  async function approve(event: FormEvent) {
    event.preventDefault();
    const requestedPath = datasetPath.trim();
    if (!requestedPath || !workspaceCurrent) return;
    const workspaceRequest = ++workspaceRequestRef.current;
    setBusy(true); setMessage("");
    try {
      const response = await trackWorkspaceMutation(localApiFetch("/api/datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: requestedPath }) }));
      const data = (await response.json()) as { dataset?: Dataset; error?: string };
      if (workspaceRequest !== workspaceRequestRef.current) return;
      if (response.status >= 500 || response.ok && !data.dataset) throw new Error("The approval response was not authoritative.");
      if (!response.ok) {
        setMessage(data.error ?? "Could not approve this dataset.");
        return;
      }
      const approvedDataset = data.dataset;
      if (!approvedDataset) throw new Error("The approval response was not authoritative.");
      setDatasetPath(""); setDatasetId(approvedDataset.id); setPreview(null); setResult(null);
      const refreshed = await refresh(workspaceRequest, `${approvedDataset.name} was approved, but the authoritative list could not be reloaded. Close and reopen the SQL workspace before continuing.`);
      if (workspaceRequest !== workspaceRequestRef.current || !refreshed) return;
      if (!refreshed.some((dataset) => dataset.id === approvedDataset.id && dataset.name === approvedDataset.name)) {
        setMessage("The approval response did not match the authoritative approved-data list. Review the list, or close and reopen the SQL workspace before continuing.");
        return;
      }
      setMessage(`${approvedDataset.name} is approved locally.`);
      await openContext(approvedDataset.id);
    } catch {
      if (workspaceRequest !== workspaceRequestRef.current) return;
      const refreshed = await refresh(workspaceRequest, "The approval request outcome could not be confirmed. Close and reopen the SQL workspace before continuing.");
      if (workspaceRequest === workspaceRequestRef.current && refreshed) {
        setMessage("The approval response was interrupted. Rangabot refreshed the authoritative approved-data list; review it before continuing.");
      }
    } finally {
      if (workspaceRequest === workspaceRequestRef.current) setBusy(false);
    }
  }

  async function chooseDataset() {
    const desktop = (window as typeof window & { rangabotDesktop?: DesktopFilePickerBridge }).rangabotDesktop;
    if (!desktop) return setMessage("Use the RangaBot desktop app to choose a local data file without typing its path.");
    const workspaceRequest = ++workspaceRequestRef.current;
    setBusy(true);
    try {
      const selection = await desktop.pickLocalFiles("dataset");
      if (workspaceRequest !== workspaceRequestRef.current) return;
      if (selection.status === "selected" && selection.paths[0]) {
        setDatasetPath(selection.paths[0]);
        setMessage(`${selection.paths[0].split(/[\\/]/).at(-1)} selected. Press Allow to grant read-only access.`);
      }
    } catch {
      if (workspaceRequest === workspaceRequestRef.current) setMessage("The local file picker did not return a selection. Try again.");
    } finally {
      if (workspaceRequest === workspaceRequestRef.current) setBusy(false);
    }
  }

  async function revoke(dataset: Dataset) {
    const workspaceRequest = ++workspaceRequestRef.current;
    setBusy(true); setMessage("");
    try {
      const response = await trackWorkspaceMutation(localApiFetch(`/api/datasets/${dataset.id}`, { method: "DELETE" }));
      if (workspaceRequest !== workspaceRequestRef.current) return;
      if (response.status >= 500) throw new Error("The revocation response was not authoritative.");
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: unknown } | null;
        if (workspaceRequest !== workspaceRequestRef.current) return;
        setMessage(typeof data?.error === "string" ? data.error : "Could not revoke this dataset.");
        return;
      }
      if (datasetId === dataset.id || contextPayload?.dataset.id === dataset.id) {
        contextRequestRef.current += 1;
        setDatasetId(""); setPreview(null); setResult(null); setContextOpen(false); setContextPayload(null); setContextMessage("");
      }
      const refreshed = await refresh(workspaceRequest, `${dataset.name} approval was revoked, but the authoritative list could not be reloaded. Close and reopen the SQL workspace before continuing.`);
      if (workspaceRequest === workspaceRequestRef.current && refreshed) {
        const stillApproved = refreshed.some((item) => item.id === dataset.id);
        const bindingResult = !stillApproved ? await onDatasetRevoked?.(dataset.id) : undefined;
        if (workspaceRequest !== workspaceRequestRef.current) return;
        setMessage(stillApproved
          ? `${dataset.name} still appears in the authoritative approved-data list, so revocation is not confirmed. Close and reopen the SQL workspace before continuing.`
          : bindingResult === "detached"
            ? `${dataset.name} approval was revoked, the file was not changed, and the open chat no longer uses it.`
            : bindingResult === "not-bound"
              ? `${dataset.name} approval was revoked and the file was not changed. The currently open chat did not require a binding change.`
              : `${dataset.name} approval was revoked and the file was not changed, but removal from the open chat was not confirmed. Sending is paused there until the chat is reopened.`);
      }
    } catch {
      if (workspaceRequest !== workspaceRequestRef.current) return;
      contextRequestRef.current += 1; analysisRequestRef.current += 1;
      setContextOpen(false); setContextPayload(null); setContextMessage(""); setPreview(null); setResult(null);
      const refreshed = await refresh(workspaceRequest, "The revocation outcome could not be confirmed. Close and reopen the SQL workspace before continuing.");
      if (workspaceRequest === workspaceRequestRef.current && refreshed) {
        const bindingResult = !refreshed.some((item) => item.id === dataset.id)
          ? await onDatasetRevoked?.(dataset.id)
          : undefined;
        if (workspaceRequest !== workspaceRequestRef.current) return;
        setMessage(bindingResult === "detached"
          ? "The revocation response was interrupted. Rangabot refreshed the authoritative list and confirmed the open chat no longer uses this dataset."
          : bindingResult === "not-bound"
            ? "The revocation response was interrupted. Rangabot refreshed the authoritative list; the currently open chat did not require a binding change."
          : "The revocation response was interrupted. Rangabot refreshed the authoritative approved-data list; review it and reopen any affected chat before sending.");
      }
    } finally {
      if (workspaceRequest === workspaceRequestRef.current) setBusy(false);
    }
  }

  async function openContext(selectedId = datasetId) {
    if (!selectedId) return;
    const workspaceRequest = workspaceRequestRef.current;
    const requestId = ++contextRequestRef.current;
    setBusy(true); setMessage(""); setContextMessage("");
    try {
      const response = await localApiFetch(`/api/datasets/${selectedId}/context`, { cache: "no-store" });
      const data = (await response.json()) as unknown;
      if (workspaceRequest !== workspaceRequestRef.current || requestId !== contextRequestRef.current) return;
      if (!response.ok || !isContextPayload(data) || data.dataset.id !== selectedId) {
        const detail = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : "Could not inspect this dataset's schema.";
        setMessage(detail); setContextMessage(`${detail} Reload the saved context or close and reopen the SQL workspace.`);
        return;
      }
      setContextPayload(data); setContextOpen(true); setContextMessage("");
    } catch {
      if (workspaceRequest === workspaceRequestRef.current && requestId === contextRequestRef.current) {
        const detail = "The saved context could not be reloaded. Try Reload saved context, or close and reopen the SQL workspace.";
        setMessage(detail); setContextMessage(detail);
      }
    } finally {
      if (workspaceRequest === workspaceRequestRef.current && requestId === contextRequestRef.current) setBusy(false);
    }
  }

  async function saveContext(status: "skipped" | "complete", context: SemanticContext) {
    const contextDatasetId = contextPayload?.dataset.id;
    if (!contextDatasetId) return;
    const expectedRevision = contextPayload.memory.revision;
    const workspaceRequest = workspaceRequestRef.current;
    const requestId = ++contextRequestRef.current;
    setBusy(true); setMessage(""); setContextMessage("");
    try {
      const response = await trackWorkspaceMutation(localApiFetch(`/api/datasets/${contextDatasetId}/context`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, context, expectedRevision }) }));
      const data = (await response.json()) as { error?: string; memory?: { revision?: unknown; status?: unknown } };
      if (workspaceRequest !== workspaceRequestRef.current || requestId !== contextRequestRef.current) return;
      if (response.status >= 500 || response.ok && (!data.memory || data.memory.revision !== expectedRevision + 1 || data.memory.status !== status)) {
        throw new Error("The context save response was not authoritative.");
      }
      if (!response.ok) {
        const detail = data.error ?? "Could not save the local dataset context.";
        const actionable = response.status === 409
          ? `${detail} Reload saved context before trying again.`
          : detail;
        setMessage(actionable); setContextMessage(actionable);
        return;
      }
      setContextOpen(false); setContextPayload(null); setContextMessage("");
      setMessage(status === "complete" ? "Context saved locally. Ranga will retrieve only the relevant parts for future questions." : "Context skipped. You can add it whenever you want.");
    } catch {
      if (workspaceRequest !== workspaceRequestRef.current || requestId !== contextRequestRef.current) return;
      try {
        const reloadResponse = await localApiFetch(`/api/datasets/${contextDatasetId}/context`, { cache: "no-store" });
        const latest = (await reloadResponse.json()) as unknown;
        if (workspaceRequest !== workspaceRequestRef.current || requestId !== contextRequestRef.current) return;
        if (reloadResponse.ok && isContextPayload(latest) && latest.dataset.id === contextDatasetId) {
          setContextPayload(latest); setContextOpen(true);
          const detail = "The save response was interrupted. Rangabot reloaded the authoritative saved context; review it before saving again or closing.";
          setMessage(detail); setContextMessage(detail);
        } else {
          const detail = latest && typeof latest === "object" && typeof (latest as { error?: unknown }).error === "string"
            ? (latest as { error: string }).error
            : "The save outcome could not be confirmed. Reload saved context, or close and reopen the SQL workspace before continuing.";
          setMessage(detail); setContextMessage(detail);
        }
      } catch {
        if (workspaceRequest === workspaceRequestRef.current && requestId === contextRequestRef.current) {
          const detail = "The save outcome could not be confirmed. Reload saved context, or close and reopen the SQL workspace before continuing.";
          setMessage(detail); setContextMessage(detail);
        }
      }
    } finally {
      if (workspaceRequest === workspaceRequestRef.current && requestId === contextRequestRef.current) setBusy(false);
    }
  }

  function closeContext() {
    contextRequestRef.current += 1;
    setContextOpen(false); setContextPayload(null); setContextMessage(""); setBusy(false);
  }

  async function createPreview(event: FormEvent) {
    event.preventDefault();
    const requestedDatasetId = datasetId;
    const requestedQuery = query;
    if (!workspaceCurrent || !requestedDatasetId || !requestedQuery.trim()) return;
    const workspaceRequest = workspaceRequestRef.current;
    const requestId = ++analysisRequestRef.current;
    setBusy(true); setMessage(""); setPreview(null); setResult(null);
    try {
      const response = await localApiFetch("/api/analysis/sql/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: requestedDatasetId, query: requestedQuery }) });
      const data = await response.json().catch(() => null) as { preview?: unknown; error?: unknown } | null;
      if (requestId !== analysisRequestRef.current || workspaceRequest !== workspaceRequestRef.current) return;
      if (!response.ok) {
        setMessage(typeof data?.error === "string" ? data.error : "Could not create the SQL proposal. Nothing was run; review the query and try again.");
        return;
      }
      if (!isPreview(data?.preview, requestedDatasetId, requestedQuery)) {
        setMessage("The SQL proposal response was incomplete or did not match the selected dataset and query. Nothing was run; review and try again.");
        return;
      }
      setPreview(data.preview);
    } catch {
      if (requestId === analysisRequestRef.current && workspaceRequest === workspaceRequestRef.current) {
        setMessage("The SQL proposal could not be confirmed. Nothing was run; review the dataset and query, then try again.");
      }
    } finally {
      if (requestId === analysisRequestRef.current && workspaceRequest === workspaceRequestRef.current) setBusy(false);
    }
  }

  async function runOnce() {
    if (!preview || !workspaceCurrent) return;
    const runningPreview = preview;
    const workspaceRequest = workspaceRequestRef.current;
    const requestId = ++analysisRequestRef.current;
    setBusy(true); setMessage("");
    try {
      const response = await localApiFetch("/api/analysis/sql/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationId: runningPreview.confirmationId, token: runningPreview.token, datasetId: runningPreview.dataset.id, query: runningPreview.query }) });
      const data = await response.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
      if (requestId !== analysisRequestRef.current || workspaceRequest !== workspaceRequestRef.current) return;
      setPreview(null);
      if (!response.ok) {
        setResult(null);
        setMessage(`${typeof data?.error === "string" ? data.error : "The SQL execution did not return a verified result."} The one-time approval is no longer trusted; create a new proposal before trying again.`);
        return;
      }
      const candidateResult = data?.result;
      if (!isResult(candidateResult, runningPreview)) {
        setResult(null);
        setMessage("The SQL execution outcome could not be confirmed because its local result receipt was incomplete or mismatched. No result was accepted; create a new proposal before trying again.");
        return;
      }
      const expectedQuerySha256 = await sha256Text(runningPreview.query);
      if (requestId !== analysisRequestRef.current || workspaceRequest !== workspaceRequestRef.current) return;
      if (candidateResult.receipt.querySha256 !== expectedQuerySha256) {
        setResult(null);
        setMessage("The SQL execution outcome could not be confirmed because its query receipt did not match the approved query. No result was accepted; create a new proposal before trying again.");
        return;
      }
      setResult(candidateResult); setMessage("Completed locally. The one-time approval has been consumed.");
    } catch {
      if (requestId === analysisRequestRef.current && workspaceRequest === workspaceRequestRef.current) {
        setPreview(null); setResult(null);
        setMessage("The SQL execution outcome could not be confirmed after the local request was interrupted. No result was accepted and the one-time approval was discarded; create a new proposal before trying again.");
      }
    } finally {
      if (requestId === analysisRequestRef.current && workspaceRequest === workspaceRequestRef.current) setBusy(false);
    }
  }

  if (!open) return null;
  return <div className="knowledge-backdrop" onMouseDown={closePanel}><aside className="sql-panel" role="dialog" aria-modal="true" aria-labelledby="sql-panel-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="knowledge-panel-header"><div><span>Private local analysis</span><h2 id="sql-panel-title">SQL workspace</h2><small>Active profile: {activeProfileMarker}</small><small>Nothing runs until you approve the exact query.</small></div><button ref={closeRef} type="button" onClick={closePanel} aria-label="Close SQL workspace"><CraftIcon name="close" /></button></div>
    <div className="sql-panel-content"><section className="sql-datasets"><header><div><strong>Approved data</strong><small>CSV, Parquet or DuckDB · 100 MB maximum</small></div><span>{workspaceCurrent ? datasets.length : "…"}</span></header>
      <div className="sql-dataset-list">{workspaceCurrent ? datasets.map((dataset) => <div key={dataset.id} className={dataset.id === datasetId ? "selected" : ""}><button type="button" disabled={busy} onClick={() => { workspaceRequestRef.current += 1; contextRequestRef.current += 1; analysisRequestRef.current += 1; setDatasetId(dataset.id); setContextOpen(false); setContextPayload(null); setContextMessage(""); setPreview(null); setResult(null); }}><strong>{dataset.name}</strong><small>{dataset.format.toUpperCase()} · {(dataset.sizeBytes / 1024 ** 2).toFixed(1)} MB</small></button><button type="button" disabled={busy} onClick={() => void revoke(dataset)} aria-label={`Revoke ${dataset.name}`}><CraftIcon name="close" size={13} /></button></div>) : <p role="status">Refreshing approved datasets…</p>}</div>
      {workspaceCurrent && datasetId && <><button type="button" className="sql-context-open" disabled={busy} onClick={() => void openContext()}>Teach Ranga about this data</button><button type="button" className="sql-attach" disabled={busy} onClick={() => { const dataset = datasets.find((item) => item.id === datasetId); if (dataset) { onAttach(dataset); closePanel(); } }}>Use selected data in chat</button></>}
      <form className="sql-allow-form" onSubmit={approve}><button type="button" className="sql-file-picker" disabled={busy || !workspaceCurrent} onClick={() => void chooseDataset()}><CraftIcon name="document" size={15} /> Choose data file</button>{datasetPath && <span title={datasetPath}>{datasetPath.split(/[\\/]/).at(-1)}</span>}<button type="submit" disabled={busy || !workspaceCurrent || !datasetPath.trim()}>Allow read-only</button></form><p>Approval stores only the local path. Revoking never deletes the file.</p>
    </section><section className="sql-workbench"><form className="sql-query-form" onSubmit={createPreview}><label htmlFor="sql-query">Exact read-only query</label><textarea id="sql-query" value={query} disabled={busy || !workspaceCurrent} onChange={(event) => { analysisRequestRef.current += 1; setQuery(event.target.value); setPreview(null); setResult(null); }} rows={7} spellCheck={false} /><button type="submit" disabled={busy || !workspaceCurrent || !datasetId || !query.trim()}>{busy ? "Preparing…" : "Review query"}</button></form>
      {workspaceCurrent && preview && <article className="sql-proposal" aria-label="SQL execution proposal"><header><div><span>Approval required</span><strong>{preview.dataset.name}</strong></div><time dateTime={preview.expiresAt}>Expires {new Date(preview.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header><pre><code>{preview.query}</code></pre><dl><div><dt>Access</dt><dd>Read only · external access off</dd></div><div><dt>Limits</dt><dd>{preview.limits.maxRows} rows · {preview.limits.timeoutMs / 1000}s</dd></div><div><dt>Dataset fingerprint</dt><dd>{preview.dataset.sha256.slice(0, 12)}…</dd></div></dl><footer><button type="button" className="sql-reject" disabled={busy || !workspaceCurrent} onClick={() => { setPreview(null); setMessage("Proposal rejected. Nothing was executed."); }}>Reject</button><button type="button" className="sql-run" disabled={busy || !workspaceCurrent} onClick={() => void runOnce()}>{busy ? "Running…" : "Run once"}</button></footer></article>}
      {workspaceCurrent && result && <article className="sql-result"><header><div><span>Verified local result</span><strong>{result.receipt.input.filename} · {result.receipt.returnedRows} row{result.receipt.returnedRows === 1 ? "" : "s"}{result.receipt.truncated ? " · truncated" : ""}</strong></div><small>{result.receipt.durationMs} ms · DuckDB</small></header><div className="sql-result-table"><table><thead><tr>{result.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{formatSqlCell(cell)}</td>)}</tr>)}</tbody></table></div><details><summary>Execution receipt</summary><code>input {result.receipt.input.sha256}</code><code>query {result.receipt.querySha256}</code></details></article>}
      {workspaceCurrent && !preview && !result && <div className="sql-empty"><CraftIcon name="analysis" size={24} /><strong>Prepare, inspect, then run</strong><p>Select an approved dataset and write one SELECT query. Chat messages and model output can never trigger execution.</p></div>}{message && <p className="sql-status" role="status">{message}</p>}
    </section></div>
    {contextOpen && contextPayload && <DatasetContextEditor key={`${contextPayload.dataset.id}-${contextPayload.memory.revision}-${contextPayload.memory.updatedAt ?? "new"}`} payload={contextPayload} busy={busy} status={contextMessage} onSave={saveContext} onReload={() => void openContext(contextPayload.dataset.id)} onClose={closeContext} />}
  </aside></div>;
}
