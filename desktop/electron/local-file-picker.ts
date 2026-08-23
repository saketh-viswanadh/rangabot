import type { BrowserWindow, Dialog } from "electron";

export const LOCAL_FILE_PICKER_CHANNEL = "rangabot:pick-local-files";
export type LocalFilePickerKind = "knowledge" | "dataset" | "repository";

export function isLocalFilePickerKind(value: unknown): value is LocalFilePickerKind {
  return value === "knowledge" || value === "dataset" || value === "repository";
}

export async function pickLocalFilesWithDialog(input: {
  kind: LocalFilePickerKind;
  window: BrowserWindow;
  dialog: Pick<Dialog, "showOpenDialog">;
  securityScopedBookmarks?: boolean;
}) {
  if (!isLocalFilePickerKind(input.kind)) throw new Error("The local file picker request is invalid.");
  const knowledge = input.kind === "knowledge";
  const repository = input.kind === "repository";
  const result = await input.dialog.showOpenDialog(input.window, {
    title: repository ? "Choose a work folder" : knowledge ? "Choose books or documents" : "Choose a data file",
    buttonLabel: repository ? "Choose folder" : knowledge ? "Choose documents" : "Choose data file",
    properties: repository ? ["openDirectory"] : knowledge ? ["openFile", "multiSelections"] : ["openFile"],
    securityScopedBookmarks: input.securityScopedBookmarks === true,
    ...(repository ? {} : {
      filters: knowledge
        ? [{ name: "Documents", extensions: ["pdf", "docx", "txt", "md", "html", "htm"] }]
        : [{ name: "Data", extensions: ["csv", "parquet", "duckdb", "db"] }],
    }),
  });
  return Object.freeze({
    status: result.canceled ? "cancelled" as const : "selected" as const,
    paths: result.canceled ? [] : result.filePaths,
    bookmarks: result.canceled ? [] : (result.bookmarks ?? []),
  });
}
