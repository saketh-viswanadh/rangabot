import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

export type SquirrelStartupEvent = "--squirrel-install" | "--squirrel-updated" | "--squirrel-uninstall" | "--squirrel-obsolete";
type SquirrelUpdateExecutableStatus = Readonly<{
  isSymbolicLink(): boolean;
  isFile(): boolean;
}>;

export function parseSquirrelStartupEvent(arguments_: readonly string[]): SquirrelStartupEvent | null {
  const event = arguments_[1];
  return event === "--squirrel-install" || event === "--squirrel-updated"
    || event === "--squirrel-uninstall" || event === "--squirrel-obsolete" ? event : null;
}

/**
 * Handles a parsed Squirrel lifecycle command after immutable artifact
 * verification, but before profile binding, Electron readiness, or any
 * private-data path is resolved.
 */
export function handleSquirrelStartup(input: {
  platform?: NodeJS.Platform;
  event: SquirrelStartupEvent;
  executablePath?: string;
  inspectUpdateExecutable?: (path: string) => SquirrelUpdateExecutableStatus;
  runUpdateExecutable?: (path: string, arguments_: readonly string[], options: {
    cwd: string;
    stdio: "ignore";
    windowsHide: true;
    timeout: number;
  }) => { error?: Error; signal?: NodeJS.Signals | null; status?: number | null };
  exit(code: number): void;
}) {
  if ((input.platform ?? process.platform) !== "win32") return false;
  const event = input.event;
  if (event === "--squirrel-obsolete") {
    input.exit(0);
    return true;
  }
  const executablePath = windowsPath.resolve(input.executablePath ?? process.execPath);
  const updateExecutable = windowsPath.resolve(windowsPath.dirname(executablePath), "..", "Update.exe");
  let exitCode = 1;
  try {
    const inspectUpdateExecutable = input.inspectUpdateExecutable ?? lstatSync;
    const runUpdateExecutable = input.runUpdateExecutable
      ?? ((path, arguments_, options) => spawnSync(path, [...arguments_], options));
    const updateStatus = inspectUpdateExecutable(updateExecutable);
    if (updateStatus.isSymbolicLink() || !updateStatus.isFile()) throw new Error("Squirrel Update.exe is unavailable.");
    const shortcutArgument = event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";
    const result = runUpdateExecutable(updateExecutable, [shortcutArgument, windowsPath.basename(executablePath)], {
      cwd: windowsPath.dirname(updateExecutable),
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
    exitCode = result.error || result.signal || result.status !== 0 ? 1 : 0;
  } catch {
    exitCode = 1;
  }
  input.exit(exitCode);
  return true;
}
