import type { App, BrowserWindow as BrowserWindowType, Dialog, Session } from "electron";
import { app, BrowserWindow, dialog, ipcMain, session, utilityProcess } from "electron";
import { join } from "node:path";
import type { DesktopArtifactVerification } from "../../lib/desktop-artifact-identity.ts";
import { createDesktopLaunch, type DesktopVerificationLaunchPolicy } from "./launch-environment.ts";
import { createSecondInstanceFocusCoordinator } from "./lifecycle.ts";
import { reserveVerifiedLoopbackPort, waitForDesktopServer } from "./loopback.ts";
import {
  isMacAppStoreRuntime,
  rememberMacSecurityScopedAccess,
  restoreMacSecurityScopedAccess,
  type MacSecurityScopedAccess,
} from "./macos-security-scoped-access.ts";
import { diagnoseLocalOllama } from "./ollama-diagnostic.ts";
import { startManagedModelRuntime, type ManagedModelRuntime } from "./model-runtime.ts";
import { startLeasedDesktopServer, type LeasedSupervisedDesktopServer } from "./process-supervisor.ts";
import { PROFILE_BACKUP_SAVE_CHANNEL, saveProfileBackupWithDialog } from "./profile-backup-save.ts";
import { isLocalFilePickerKind, LOCAL_FILE_PICKER_CHANNEL, pickLocalFilesWithDialog } from "./local-file-picker.ts";
import { createDesktopRuntimeBoundaryFromVerifiedResources } from "./resource-boundary.ts";
import {
  DESKTOP_RENDERER_WEB_PREFERENCES,
  installDesktopSessionGuards,
  installDesktopWebContentsGuards,
} from "./security.ts";
import {
  verifyDesktopResourcesBeforeMutation,
  type VerifiedDesktopResources,
} from "./startup-verification.ts";
import { prepareDesktopStartupProfileBeforeLock, type PreparedDesktopStartupProfile } from "./verification-profile.ts";

const PRELOAD_PATH = join(import.meta.dirname, "preload.cjs");
const STARTUP_TIMEOUT_MS = 30_000;

type DesktopStartupStage =
  | "S10_ARTIFACT_VERIFY"
  | "S20_PROFILE_BIND"
  | "S30_SANDBOX_ENABLE"
  | "S40_LOCK_REQUEST"
  | "S41_LOCK_PRIMARY"
  | "S42_LOCK_SECONDARY"
  | "S50_APP_READY"
  | "A10_RESOURCE_BOUNDARY"
  | "A20_RUNTIME_EVIDENCE"
  | "A30_ARTIFACT_INSPECTION"
  | "A41_MANIFEST_INVALID"
  | "A42_MANIFEST_UNAVAILABLE"
  | "A43_IDENTITY_MISMATCH"
  | "A44_RUNTIME_MISMATCH"
  | "A45_RESOURCE_MISMATCH"
  | "R10_RESOURCES"
  | "R20_USER_DATA"
  | "R30_PORT"
  | "R40_BOUNDARY_LAUNCH"
  | "R50_SESSION_GUARDS"
  | "R60_SERVER_START"
  | "R70_READINESS"
  | "R80_WINDOW_CREATE"
  | "R90_WINDOW_LOAD"
  | "R99_RUNNING"
  | "X90_RUNTIME_FAILURE";

function emitStartupStage(stage: DesktopStartupStage, failure = false) {
  try {
    console.error(`RANGABOT_DESKTOP_${failure ? "FAILURE" : "STAGE"}=${stage}`);
  } catch {
    // Diagnostic output must never influence startup.
  }
}

type RuntimeState = {
  window?: BrowserWindowType;
  server?: LeasedSupervisedDesktopServer;
  modelRuntime?: ManagedModelRuntime;
  securityScopedAccess: MacSecurityScopedAccess[];
  stopping: boolean;
  stopPromise?: Promise<void>;
};

function desktopOrigin(port: number) {
  return `http://127.0.0.1:${port}`;
}

function showStartupError(error: unknown, nativeDialog: Pick<Dialog, "showErrorBox"> = dialog) {
  const detail = error instanceof Error ? error.message : "An unknown local startup error occurred.";
  nativeDialog.showErrorBox(
    "Rangabot could not open",
    `${detail}\n\nNo remote service was contacted. Your existing local data was left untouched.`,
  );
}

function createMainWindow(allowedOrigin: string, desktopSession: Session, title: "Rangabot" | "Rangabot Verification") {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#17130f",
    title,
    autoHideMenuBar: true,
    webPreferences: {
      ...DESKTOP_RENDERER_WEB_PREFERENCES,
      preload: PRELOAD_PATH,
      session: desktopSession,
    },
  });
  installDesktopWebContentsGuards(window.webContents, allowedOrigin);
  window.once("ready-to-show", () => window.show());
  return window;
}

function stopRuntime(state: RuntimeState) {
  if (state.stopPromise) return state.stopPromise;
  state.stopping = true;
  state.stopPromise = (async () => {
    try { await state.server?.stop(); }
    finally {
      state.server = undefined;
      await state.modelRuntime?.stop();
      state.modelRuntime = undefined;
      for (const access of state.securityScopedAccess.splice(0).reverse()) access.stop();
    }
  })();
  return state.stopPromise;
}

export async function startDesktopRuntime(input: {
  electronApp?: App;
  resourcesPath?: string;
  developmentResourceRoot?: string;
  fork?: typeof utilityProcess.fork;
  desktopSession?: Session;
  signal?: AbortSignal;
  acquireLease?: Parameters<typeof startLeasedDesktopServer>[0]["acquireLease"];
  verifyArtifact?: (artifactRoot: string, resourceRoot: string, manifestPath: string) => DesktopArtifactVerification;
  verifiedResources?: VerifiedDesktopResources;
  userDataPath?: string;
  windowTitle?: "Rangabot" | "Rangabot Verification";
  verificationPolicy?: DesktopVerificationLaunchPolicy;
  reservePort?: typeof reserveVerifiedLoopbackPort;
} = {}) {
  emitStartupStage("R10_RESOURCES");
  const electronApp = input.electronApp ?? app;
  const state: RuntimeState = { stopping: false, securityScopedAccess: [] };
  input.signal?.throwIfAborted();
  const verified = input.verifiedResources ?? verifyDesktopResourcesBeforeMutation({
    resourcesPath: input.resourcesPath ?? process.resourcesPath,
    isPackaged: electronApp.isPackaged,
    developmentResourceRoot: input.developmentResourceRoot,
    verifyArtifact: input.verifyArtifact,
  });
  input.signal?.throwIfAborted();
  emitStartupStage("R20_USER_DATA");
  const userDataPath = input.userDataPath ?? electronApp.getPath("userData");
  emitStartupStage("R30_PORT");
  const port = await (input.reservePort ?? reserveVerifiedLoopbackPort)();
  input.signal?.throwIfAborted();
  emitStartupStage("R40_BOUNDARY_LAUNCH");
  const boundary = createDesktopRuntimeBoundaryFromVerifiedResources({
    resources: verified.resources,
    userDataPath,
  });
  const macAppStore = isMacAppStoreRuntime();
  if (macAppStore) {
    state.securityScopedAccess.push(restoreMacSecurityScopedAccess({ app: electronApp, userDataPath }));
  }
  const artifact = verified.artifact;
  let modelBaseUrl: string | undefined;
  if (!input.verificationPolicy) {
    const modelPort = await (input.reservePort ?? reserveVerifiedLoopbackPort)();
    state.modelRuntime = await startManagedModelRuntime({
      boundary,
      port: modelPort,
      standardModelsRoot: macAppStore ? undefined : join(electronApp.getPath("home"), ".ollama", "models"),
    });
    modelBaseUrl = state.modelRuntime.baseUrl;
  }
  const launch = createDesktopLaunch({
    boundary,
    port,
    verificationPolicy: input.verificationPolicy,
    baseEnvironment: modelBaseUrl ? { ...process.env, OLLAMA_BASE_URL: modelBaseUrl } : process.env,
  });
  const origin = desktopOrigin(port);
  emitStartupStage("R50_SESSION_GUARDS");
  const desktopSession = input.desktopSession ?? session.fromPartition("rangabot-desktop-session", { cache: false });
  installDesktopSessionGuards(desktopSession as unknown as Parameters<typeof installDesktopSessionGuards>[0], origin);
  try {
    emitStartupStage("R60_SERVER_START");
    state.server = await startLeasedDesktopServer({
      fork: (input.fork ?? utilityProcess.fork) as unknown as Parameters<typeof startLeasedDesktopServer>[0]["fork"],
      boundary,
      launch,
      acquireLease: input.acquireLease,
    });
    const serverProcessId = state.server.processId;
    emitStartupStage("R70_READINESS");
    await waitForDesktopServer({
      port,
      readiness: launch.readiness,
      expectedProcessId: serverProcessId,
      timeoutMs: STARTUP_TIMEOUT_MS,
      exited: state.server.exit,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
    emitStartupStage("R80_WINDOW_CREATE");
    state.window = createMainWindow(origin, desktopSession, input.windowTitle ?? "Rangabot");
    ipcMain.removeHandler(PROFILE_BACKUP_SAVE_CHANNEL);
    ipcMain.removeHandler(LOCAL_FILE_PICKER_CHANNEL);
    if (!input.verificationPolicy) {
      ipcMain.handle(PROFILE_BACKUP_SAVE_CHANNEL, async (event, request) => {
        if (!state.window || state.window.isDestroyed() || event.sender !== state.window.webContents) {
          throw new Error("The profile backup request did not come from the active local RangaBot window.");
        }
        return saveProfileBackupWithDialog({ request, window: state.window });
      });
      ipcMain.handle(LOCAL_FILE_PICKER_CHANNEL, async (event, request: { kind?: unknown }) => {
        if (!state.window || state.window.isDestroyed() || event.sender !== state.window.webContents) throw new Error("The file picker request did not come from the active local RangaBot window.");
        if (!isLocalFilePickerKind(request?.kind)) throw new Error("The local file picker request is invalid.");
        const picked = await pickLocalFilesWithDialog({
          kind: request.kind,
          window: state.window,
          dialog,
          securityScopedBookmarks: macAppStore,
        });
        if (macAppStore && picked.status === "selected") {
          state.securityScopedAccess.push(rememberMacSecurityScopedAccess({
            app: electronApp,
            userDataPath,
            paths: picked.paths,
            bookmarks: picked.bookmarks,
          }));
        }
        return Object.freeze({ status: picked.status, paths: picked.paths });
      });
    }
    emitStartupStage("R90_WINDOW_LOAD");
    await state.window.loadURL(launch.bootstrapUrl);
    emitStartupStage("R99_RUNNING");
    if (artifact.state === "dirty") {
      void dialog.showMessageBox(state.window, {
        type: "warning",
        title: "Unverified development build",
        message: "This local desktop build is not release-verified.",
        detail: "Response feedback remains ineligible for known-build aggregation. Your local conversations and preferences remain private.",
        buttons: ["Continue"],
        noLink: true,
      });
    }
  } catch (error) {
    ipcMain.removeHandler(PROFILE_BACKUP_SAVE_CHANNEL);
    ipcMain.removeHandler(LOCAL_FILE_PICKER_CHANNEL);
    await stopRuntime(state);
    throw error;
  }
  if (!input.verificationPolicy && !state.modelRuntime) {
    void diagnoseLocalOllama({
      baseUrl: launch.environment.OLLAMA_BASE_URL,
      model: launch.environment.OLLAMA_MODEL,
    }).then((diagnostic) => {
      if (diagnostic.kind !== "ready" && state.window && !state.window.isDestroyed()) {
        void dialog.showMessageBox(state.window, {
          type: "warning",
          title: diagnostic.title,
          message: diagnostic.title,
          detail: diagnostic.message,
          buttons: ["Continue"],
          noLink: true,
        });
      }
    });
  }
  state.server.exit.then(({ code }) => {
    if (!state.stopping) {
      showStartupError(new Error(`Rangabot's local server stopped unexpectedly (exit ${code}).`));
      electronApp.quit();
    }
  });
  return Object.freeze({ state, stop: () => stopRuntime(state) });
}

let initialVerification: VerifiedDesktopResources | undefined;
let initialProfile: PreparedDesktopStartupProfile | undefined;
let startupPreludeStage: DesktopStartupStage = "S10_ARTIFACT_VERIFY";
try {
  emitStartupStage(startupPreludeStage);
  initialVerification = verifyDesktopResourcesBeforeMutation({
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    reportStage(stage) {
      startupPreludeStage = stage;
      emitStartupStage(stage);
    },
  });
  const launchProfile = initialVerification.artifact.manifest?.launchProfile;
  if (!launchProfile) throw new Error("The verified desktop artifact has no sealed launch profile.");
  startupPreludeStage = "S20_PROFILE_BIND";
  emitStartupStage(startupPreludeStage);
  initialProfile = prepareDesktopStartupProfileBeforeLock({
    electronApp: app,
    launchProfile,
    isPackaged: app.isPackaged,
    platform: process.platform,
    windowsStore: Boolean((process as NodeJS.Process & { windowsStore?: boolean }).windowsStore),
    macAppStore: isMacAppStoreRuntime(),
    localAppDataPath: process.env.LOCALAPPDATA,
    execPath: process.execPath,
  });
} catch {
  emitStartupStage(startupPreludeStage, true);
  // Reject an untrusted app without resolving private paths, presenting UI or
  // installing lifecycle hooks that may cause Electron-managed state writes.
  app.exit(1);
}

if (initialVerification && initialProfile) {
  emitStartupStage("S30_SANDBOX_ENABLE");
  app.enableSandbox();
  emitStartupStage("S40_LOCK_REQUEST");
  const primaryInstance = app.requestSingleInstanceLock();
  if (!primaryInstance) {
    emitStartupStage("S42_LOCK_SECONDARY");
    app.quit();
  } else {
    emitStartupStage("S41_LOCK_PRIMARY");
    let runtime: Awaited<ReturnType<typeof startDesktopRuntime>> | undefined;
    let startup: Promise<Awaited<ReturnType<typeof startDesktopRuntime>>> | undefined;
    let finalExitStarted = false;
    const startupAbort = new AbortController();
    const focusCoordinator = createSecondInstanceFocusCoordinator(() => runtime?.state.window);
    app.on("second-instance", () => focusCoordinator.onSecondInstance());
    const shutDown = async (exitCode: number) => {
      if (finalExitStarted) return;
      finalExitStarted = true;
      startupAbort.abort(new Error("Rangabot desktop startup was cancelled."));
      try {
        const started = runtime ?? await startup?.catch(() => undefined);
        await started?.stop();
      } finally {
        app.exit(exitCode);
      }
    };
    app.on("before-quit", (event) => {
      if (finalExitStarted) return;
      event.preventDefault();
      void shutDown(0);
    });
    app.on("window-all-closed", () => app.quit());
    app.whenReady().then(async () => {
      emitStartupStage("S50_APP_READY");
      try {
        startup = startDesktopRuntime({
          signal: startupAbort.signal,
          verifiedResources: initialVerification,
          userDataPath: initialProfile.userDataPath,
          windowTitle: initialProfile.windowTitle,
          verificationPolicy: initialProfile.verificationPolicy,
        });
        runtime = await startup;
        focusCoordinator.onWindowReady();
      } catch (error) {
        emitStartupStage("X90_RUNTIME_FAILURE", true);
        if (!startupAbort.signal.aborted) showStartupError(error);
        await shutDown(1);
      }
    });
  }
}
