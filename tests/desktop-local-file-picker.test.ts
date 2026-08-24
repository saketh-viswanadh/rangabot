import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import {
  isLocalFilePickerKind,
  LOCAL_FILE_PICKER_CHANNEL,
  pickLocalFilesWithDialog,
} from "../desktop/electron/local-file-picker.ts";

test("repository picker selects one work folder without reading or approving it", async () => {
  const selectedPath = "/synthetic/private/work-folder";
  const window = {};
  let dialogCalls = 0;
  const result = await pickLocalFilesWithDialog({
    kind: "repository",
    window: window as never,
    dialog: {
      async showOpenDialog(receivedWindow: BrowserWindow, options: OpenDialogOptions) {
        dialogCalls += 1;
        assert.equal(receivedWindow, window);
        assert.deepEqual(options, {
          title: "Choose a work folder",
          buttonLabel: "Choose folder",
          properties: ["openDirectory"],
          securityScopedBookmarks: false,
        });
        return { canceled: false, filePaths: [selectedPath] };
      },
    } as never,
  });

  assert.equal(dialogCalls, 1);
  assert.deepEqual(result, { status: "selected", paths: [selectedPath], bookmarks: [] });
  assert.deepEqual(Object.keys(result).sort(), ["bookmarks", "paths", "status"]);
});

test("repository picker returns cancellation without a path", async () => {
  const result = await pickLocalFilesWithDialog({
    kind: "repository",
    window: {} as never,
    dialog: {
      async showOpenDialog() {
        return { canceled: true, filePaths: ["/must/not/be/returned"] };
      },
    } as never,
  });
  assert.deepEqual(result, { status: "cancelled", paths: [], bookmarks: [] });
});

test("Mac App Store picker requests and returns app-scoped bookmark bytes", async () => {
  const bookmark = Buffer.from("synthetic-app-scoped-bookmark").toString("base64");
  const result = await pickLocalFilesWithDialog({
    kind: "dataset",
    window: {} as never,
    securityScopedBookmarks: true,
    dialog: {
      async showOpenDialog(_window: BrowserWindow, options: OpenDialogOptions) {
        assert.equal(options.securityScopedBookmarks, true);
        return { canceled: false, filePaths: ["/synthetic/data.csv"], bookmarks: [bookmark] };
      },
    } as never,
  });
  assert.deepEqual(result, { status: "selected", paths: ["/synthetic/data.csv"], bookmarks: [bookmark] });
});

test("repository picker surfaces native dialog errors without fallback access", async () => {
  const failure = new Error("synthetic native picker failure");
  await assert.rejects(
    pickLocalFilesWithDialog({
      kind: "repository",
      window: {} as never,
      dialog: { async showOpenDialog() { throw failure; } } as never,
    }),
    (error) => error === failure,
  );
});

test("local picker rejects invalid kinds before opening a native dialog", async () => {
  let dialogCalls = 0;
  await assert.rejects(
    pickLocalFilesWithDialog({
      kind: "folder" as never,
      window: {} as never,
      dialog: { async showOpenDialog() { dialogCalls += 1; throw new Error("must not run"); } } as never,
    }),
    /local file picker request is invalid/i,
  );
  assert.equal(dialogCalls, 0);
  assert.deepEqual(
    ["knowledge", "dataset", "repository", "folder", undefined].map(isLocalFilePickerKind),
    [true, true, true, false, false],
  );
});

test("desktop preload exposes repository selection and rejects other kinds locally", async () => {
  const source = readFileSync("desktop/electron/preload.cjs", "utf8");
  const invocations: Array<{ channel: string; request: unknown }> = [];
  let bridge: { pickLocalFiles(kind: unknown): Promise<unknown> } | undefined;
  runInNewContext(source, {
    require(id: string) {
      assert.equal(id, "electron");
      return {
        contextBridge: { exposeInMainWorld(name: string, value: typeof bridge) { assert.equal(name, "rangabotDesktop"); bridge = value; } },
        ipcRenderer: { invoke(channel: string, request: unknown) { invocations.push({ channel, request }); return Promise.resolve({ status: "cancelled", paths: [] }); } },
      };
    },
    ArrayBuffer,
    Uint8Array,
    Error,
    Object,
    Promise,
  });

  assert.ok(bridge);
  await bridge.pickLocalFiles("repository");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.channel, LOCAL_FILE_PICKER_CHANNEL);
  assert.equal((invocations[0]?.request as { kind?: unknown })?.kind, "repository");
  await assert.rejects(bridge.pickLocalFiles("folder"), /local file picker request is invalid/i);
  assert.equal(invocations.length, 1);
});

test("desktop picker bridge retains sender validation and has no directory read or approval capability", () => {
  const picker = readFileSync("desktop/electron/local-file-picker.ts", "utf8");
  const preload = readFileSync("desktop/electron/preload.cjs", "utf8");
  const main = readFileSync("desktop/electron/main.ts", "utf8");

  assert.match(main, /event\.sender !== state\.window\.webContents/);
  assert.match(main, /if \(!isLocalFilePickerKind\(request\?\.kind\)\) throw new Error/);
  assert.match(preload, /kind !== "knowledge" && kind !== "dataset" && kind !== "repository"/);
  assert.match(picker, /properties: repository \? \["openDirectory"\]/);
  assert.doesNotMatch(`${picker}\n${preload}`, /node:fs|readdir|readFile|statSync|realpath|allowRepository|approveDataset|localApiFetch|fetch\s*\(/);
});
