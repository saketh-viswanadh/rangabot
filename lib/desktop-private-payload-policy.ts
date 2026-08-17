const publicDesktopDataFiles = new Set([
  "data/knowledge/new_this_week.md",
  "data/knowledge/new_this_month.md",
  "data/knowledge/source_manifest.json",
  "data/knowledge/evaluations/starter.json",
]);

export function isForbiddenDesktopPrivateResourcePath(pathInput: string) {
  const path = pathInput.toLowerCase();
  if (!path || path.startsWith("/") || path.includes("\\")
    || path.split("/").some((component) => component === "" || component === "." || component === "..")) {
    return true;
  }
  if (path.startsWith("data/") && !publicDesktopDataFiles.has(path)) return true;
  return /(?:^|\/)(?:rangabot(?:-memory)?\.db|datasets\.json|repositories\.json|sql-confirmations\.json)(?:$|\/)/.test(path)
    || /(?:\.sqlite3?|\.duckdb|-wal|-shm|\.journal)$/.test(path)
    || /(?:\.gguf|\.ggml|\.safetensors)$/.test(path)
    || /(^|\/)\.ollama(?:\/|$)/.test(path)
    || /(^|\/)models\/(?:blobs|manifests)(?:\/|$)/.test(path)
    || /^(?:artifacts|inbox|processed|indexes|backups|results)(?:\/|$)/.test(path)
    || /^(?:knowledge\/(?:inbox|processed|indexes|backups)|evaluations\/results)(?:\/|$)/.test(path);
}
