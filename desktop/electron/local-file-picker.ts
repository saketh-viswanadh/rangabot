import type { BrowserWindow, Dialog } from "electron";

export const LOCAL_FILE_PICKER_CHANNEL = "rangabot:pick-local-files";
export type LocalFilePickerKind = "knowledge" | "dataset";

export async function pickLocalFilesWithDialog(input: { kind: LocalFilePickerKind; window: BrowserWindow; dialog: Pick<Dialog, "showOpenDialog"> }) {
  const knowledge = input.kind === "knowledge";
  const result = await input.dialog.showOpenDialog(input.window, {
    title: knowledge ? "Choose books or documents" : "Choose a data file",
    buttonLabel: knowledge ? "Choose documents" : "Choose data file",
    properties: knowledge ? ["openFile", "multiSelections"] : ["openFile"],
    filters: knowledge
      ? [{ name: "Documents", extensions: ["pdf", "docx", "txt", "md", "html", "htm"] }]
      : [{ name: "Data", extensions: ["csv", "parquet", "duckdb", "db"] }],
  });
  return Object.freeze({ status: result.canceled ? "cancelled" as const : "selected" as const, paths: result.canceled ? [] : result.filePaths });
}
