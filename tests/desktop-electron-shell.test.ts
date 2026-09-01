import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FuseState, FuseV1Options } from "@electron/fuses";
import {
  electronFuseOptions,
  ELECTRON_FUSE_POLICY,
  ELECTRON_FUSE_POLICY_NAME,
  ELECTRON_MAJOR_VERSION,
} from "../desktop/electron/fuses.ts";
import { DESKTOP_FUSE_POLICY_NAME, REQUIRED_DESKTOP_FUSE_WIRE_STATES } from "../lib/desktop-artifact-identity.ts";
import {
  createDesktopReadinessCapability,
  DESKTOP_READINESS_CHALLENGE_HEADER,
  DESKTOP_READINESS_PATH,
  DESKTOP_READINESS_PROCESS_HEADER,
  DESKTOP_READINESS_PROOF_HEADER,
  evaluateDesktopReadinessRequest,
  issueDesktopReadinessProof,
  verifyDesktopReadinessProof,
} from "../lib/desktop-startup-security.ts";
import { createDesktopLaunch } from "../desktop/electron/launch-environment.ts";
import { createSecondInstanceFocusCoordinator, focusDesktopWindow } from "../desktop/electron/lifecycle.ts";
import {
  DESKTOP_LOOPBACK_HOST,
  DesktopServerStartupError,
  probeDesktopServer,
  reserveVerifiedLoopbackPort,
  waitForDesktopServer,
} from "../desktop/electron/loopback.ts";
import { diagnoseLocalOllama, parseLoopbackOllamaUrl } from "../desktop/electron/ollama-diagnostic.ts";
import {
  desktopRuntimeLeasePath,
  descendantProcessIds,
  parseProcessTable,
  startLeasedDesktopServer,
  startSupervisedDesktopServer,
  type UtilityProcessLike,
} from "../desktop/electron/process-supervisor.ts";
import { createDesktopRuntimeBoundary, resolveDesktopResourceBoundary } from "../desktop/electron/resource-boundary.ts";
import { verifyDesktopResourcesBeforeMutation } from "../desktop/electron/startup-verification.ts";
import {
  DESKTOP_RENDERER_WEB_PREFERENCES,
  installDesktopSessionGuards,
  installDesktopWebContentsGuards,
  isAllowedDesktopDocumentUrl,
} from "../desktop/electron/security.ts";
import { verifyExpectedLocalBootstrapToken } from "../lib/local-session-token.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-electron-shell-"));
  const resourcesPath = join(root, "resources");
  const resourceRoot = join(resourcesPath, "rangabot-resources");
  const userDataPath = join(root, "user-data");
  mkdirSync(join(resourceRoot, "desktop"), { recursive: true });
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  writeFileSync(join(resourceRoot, "server.js"), "// synthetic packaged server\n");
  writeFileSync(join(resourceRoot, "desktop", "manifest.json"), "{}\n");
  return { root, resourcesPath, resourceRoot, userDataPath };
}

test("Electron 43 fuse policy disables Node escape hatches and requires ASAR integrity", () => {
  assert.equal(ELECTRON_MAJOR_VERSION, 43);
  assert.equal(ELECTRON_FUSE_POLICY_NAME, DESKTOP_FUSE_POLICY_NAME);
  assert.deepEqual(ELECTRON_FUSE_POLICY, {
    policyName: "electron-43-hardened-v2",
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false,
    WasmTrapHandlers: true,
  });
  assert.deepEqual(electronFuseOptions("darwin", "arm64"), { resetAdHocDarwinSignature: true });
  assert.throws(() => electronFuseOptions("darwin", "x64"), /arm64 only/);
  assert.deepEqual(electronFuseOptions("win32", "x64"), { resetAdHocDarwinSignature: false });
  const namedStates = new Map<number, FuseState>([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);
  assert.deepEqual([...namedStates.keys()], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...namedStates.values()], [...REQUIRED_DESKTOP_FUSE_WIRE_STATES]);
  assert.equal(String.fromCharCode(...REQUIRED_DESKTOP_FUSE_WIRE_STATES), "010011001");
  const packageRecord = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.equal(packageRecord.devDependencies?.["@electron/fuses"], "2.1.3");
  const forgeSource = readFileSync(join(projectRoot, "forge.config.cjs"), "utf8");
  assert.match(forgeSource, /FUSE_POLICY_NAME\s*=\s*"electron-43-hardened-v2"/);
  assert.match(forgeSource, /strictlyRequireAllFuses:\s*true/);
  assert.match(forgeSource, /\[FuseV1Options\.LoadBrowserProcessSpecificV8Snapshot\]:\s*false/);
  assert.match(forgeSource, /\[FuseV1Options\.WasmTrapHandlers\]:\s*true/);
});

test("renderer preferences are explicit, sandboxed, isolated and unprivileged", () => {
  assert.deepEqual(DESKTOP_RENDERER_WEB_PREFERENCES, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    devTools: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
  });
  const preload = readFileSync(join(projectRoot, "desktop", "electron", "preload.cjs"), "utf8").trim();
  assert.match(preload, /contextBridge\.exposeInMainWorld\("rangabotDesktop"/);
  assert.match(preload, /saveProfileBackup/);
  assert.match(preload, /rangabot:save-profile-backup/);
  assert.match(preload, /pickLocalFiles/);
  assert.match(preload, /rangabot:pick-local-files/);
  assert.doesNotMatch(preload, /require\(["']node:(?:fs|path|child_process|process)["']\)|process\.|readFile|writeFile|exec|spawn/);
});

test("desktop URL allowlist accepts only its exact loopback HTTP origin", () => {
  const origin = "http://127.0.0.1:43127";
  assert.equal(isAllowedDesktopDocumentUrl(`${origin}/` , origin), true);
  assert.equal(isAllowedDesktopDocumentUrl(`${origin}/api/status`, origin), true);
  for (const url of [
    "http://localhost:43127/",
    "http://127.0.0.1:43128/",
    "https://127.0.0.1:43127/",
    "http://evil.test/",
    "file:///tmp/attack",
    "javascript:alert(1)",
  ]) assert.equal(isAllowedDesktopDocumentUrl(url, origin), false, url);
});

test("session and WebContents guards deny permissions, downloads, remote traffic, windows and navigation", () => {
  let permissionCheck: (() => boolean) | undefined;
  let permissionRequest: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
  let download: ((event: { preventDefault(): void }) => void) | undefined;
  let beforeRequest: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | undefined;
  const desktopSession = {
    setPermissionCheckHandler(handler: () => boolean) { permissionCheck = handler; },
    setPermissionRequestHandler(handler: typeof permissionRequest) { permissionRequest = handler; },
    on(_event: "will-download", handler: typeof download) { download = handler; },
    webRequest: { onBeforeRequest(_filter: { urls: string[] }, handler: typeof beforeRequest) { beforeRequest = handler; } },
  };
  const origin = "http://127.0.0.1:45191";
  installDesktopSessionGuards(desktopSession, origin);
  assert.equal(permissionCheck?.(), false);
  let allowed = true;
  permissionRequest?.({}, "camera", (result) => { allowed = result; });
  assert.equal(allowed, false);
  let prevented = false;
  download?.({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  for (const [url, expected] of [[`${origin}/_next/static/app.js`, false], ["https://example.com/", true], ["ws://127.0.0.1:45191/", true]] as const) {
    let cancelled: boolean | undefined;
    beforeRequest?.({ url }, (response) => { cancelled = response.cancel; });
    assert.equal(cancelled, expected, url);
  }

  const handlers = new Map<string, (...args: never[]) => void>();
  let openHandler: (() => { action: "deny" }) | undefined;
  const contents = {
    setWindowOpenHandler(handler: typeof openHandler) { openHandler = handler; },
    on(event: "will-navigate" | "will-redirect" | "will-attach-webview", handler: (...args: never[]) => void) { handlers.set(event, handler); },
  };
  installDesktopWebContentsGuards(contents, origin);
  assert.deepEqual(openHandler?.(), { action: "deny" });
  let remotePrevented = false;
  handlers.get("will-navigate")?.({ preventDefault() { remotePrevented = true; } } as never, "https://example.com" as never);
  assert.equal(remotePrevented, true);
  let localPrevented = false;
  handlers.get("will-redirect")?.({ preventDefault() { localPrevented = true; } } as never, `${origin}/` as never);
  assert.equal(localPrevented, false);
  let webviewPrevented = false;
  handlers.get("will-attach-webview")?.({ preventDefault() { webviewPrevented = true; } } as never);
  assert.equal(webviewPrevented, true);
});

test("packaged resource and private data roots are explicit, canonical and separate", () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const canonicalResourceRoot = realpathSync(testFixture.resourceRoot);
  const canonicalArtifactRoot = realpathSync(testFixture.resourcesPath);
  const canonicalUserDataRoot = realpathSync(testFixture.userDataPath);
  assert.equal(boundary.artifactRoot, canonicalArtifactRoot);
  assert.equal(boundary.resourceRoot, canonicalResourceRoot);
  assert.equal(boundary.serverEntrypoint, join(canonicalResourceRoot, "server.js"));
  assert.equal(boundary.desktopManifestPath, join(canonicalResourceRoot, "desktop", "manifest.json"));
  assert.equal(boundary.dataRoot, join(canonicalUserDataRoot, "private-data"));
  if (process.platform !== "win32") assert.equal(statSync(boundary.dataRoot).mode & 0o777, 0o700);
  assert.notEqual(boundary.resourceRoot, boundary.dataRoot);
  assert.notEqual(boundary.artifactRoot, boundary.resourceRoot);
});

test("first launch creates a private data root when Electron userData does not exist yet", () => {
  const testFixture = fixture();
  const freshUserDataPath = join(testFixture.root, "fresh-user-data");
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: freshUserDataPath,
    isPackaged: true,
  });
  assert.equal(boundary.dataRoot, join(realpathSync(freshUserDataPath), "private-data"));
  if (process.platform !== "win32") assert.equal(statSync(boundary.dataRoot).mode & 0o777, 0o700);
});

test("tampered launch rejection leaves every path outside the disposable app copy unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-electron-tamper-order-"));
  const appCopy = join(root, "disposable-app-copy");
  const resourcesPath = join(appCopy, "Contents", "Resources");
  const resourceRoot = join(resourcesPath, "rangabot-resources");
  const userDataPath = join(root, "synthetic-user-data");
  const unrelated = join(root, "unrelated");
  mkdirSync(join(resourceRoot, "desktop"), { recursive: true });
  mkdirSync(unrelated);
  writeFileSync(join(resourceRoot, "server.js"), "tampered packaged server\n");
  writeFileSync(join(resourceRoot, "desktop", "manifest.json"), "{}\n");
  writeFileSync(join(unrelated, "sentinel.txt"), "must remain byte-identical\n");
  const snapshotOutsideApp = () => ({
    rootEntries: readdirSync(root).filter((entry) => entry !== "disposable-app-copy").sort(),
    unrelatedEntries: readdirSync(unrelated).sort(),
    sentinel: readFileSync(join(unrelated, "sentinel.txt"), "utf8"),
  });
  const before = snapshotOutsideApp();
  let verificationCalls = 0;
  assert.throws(() => verifyDesktopResourcesBeforeMutation({
    resourcesPath,
    isPackaged: true,
    verifyArtifact(artifactRoot, verifiedResourceRoot, manifestPath) {
      verificationCalls += 1;
      assert.equal(artifactRoot, realpathSync(resourcesPath));
      assert.equal(verifiedResourceRoot, realpathSync(resourceRoot));
      assert.equal(manifestPath, join(realpathSync(resourceRoot), "desktop", "manifest.json"));
      assert.match(readFileSync(join(verifiedResourceRoot, "server.js"), "utf8"), /tampered/);
      return {
        state: "mixed",
        candidateBuildId: null,
        build: null,
        baseCommit: null,
        manifestSha256: null,
        artifactSha256: null,
        sourceVersion: null,
        productVersion: null,
        macBuildNumber: null,
        reason: "resource-mismatch",
        manifest: null,
      };
    },
  }), /identity is mixed \(resource-mismatch\)/);
  assert.equal(verificationCalls, 1);
  assert.equal(existsSync(userDataPath), false);
  assert.equal(existsSync(join(userDataPath, "private-data")), false);
  assert.equal(existsSync(join(userDataPath, "private-data", "tmp")), false);
  assert.deepEqual(snapshotOutsideApp(), before);
});

test("desktop startup reports a dedicated product-version mismatch before private runtime mutation", () => {
  const testFixture = fixture();
  const stages: string[] = [];
  assert.throws(() => verifyDesktopResourcesBeforeMutation({
    resourcesPath: testFixture.resourcesPath,
    isPackaged: true,
    reportStage(stage) { stages.push(stage); },
    verifyArtifact() {
      return {
        state: "mixed",
        candidateBuildId: null,
        build: null,
        baseCommit: null,
        manifestSha256: null,
        artifactSha256: null,
        sourceVersion: null,
        productVersion: null,
        macBuildNumber: null,
        reason: "product-version-mismatch",
        manifest: null,
      };
    },
  }), /product-version-mismatch/);
  assert.deepEqual(stages, [
    "A10_RESOURCE_BOUNDARY",
    "A20_RUNTIME_EVIDENCE",
    "A30_ARTIFACT_INSPECTION",
    "A46_PRODUCT_VERSION_MISMATCH",
  ]);
  assert.equal(existsSync(join(testFixture.userDataPath, "private-data")), false);
});

test("desktop startup reports a dedicated Mac build-number mismatch before private runtime mutation", () => {
  const testFixture = fixture();
  const stages: string[] = [];
  assert.throws(() => verifyDesktopResourcesBeforeMutation({
    resourcesPath: testFixture.resourcesPath,
    isPackaged: true,
    reportStage(stage) { stages.push(stage); },
    verifyArtifact() {
      return {
        state: "mixed",
        candidateBuildId: null,
        build: null,
        baseCommit: null,
        manifestSha256: null,
        artifactSha256: null,
        sourceVersion: null,
        productVersion: null,
        macBuildNumber: null,
        reason: "mac-build-number-mismatch",
        manifest: null,
      };
    },
  }), /mac-build-number-mismatch/);
  assert.deepEqual(stages, [
    "A10_RESOURCE_BOUNDARY",
    "A20_RUNTIME_EVIDENCE",
    "A30_ARTIFACT_INSPECTION",
    "A47_MAC_BUILD_NUMBER_MISMATCH",
  ]);
  assert.equal(existsSync(join(testFixture.userDataPath, "private-data")), false);
});

test("packaged resource boundary rejects overrides, symlinks and non-files", () => {
  const testFixture = fixture();
  assert.throws(() => resolveDesktopResourceBoundary({
    resourcesPath: testFixture.resourcesPath,
    isPackaged: true,
    developmentResourceRoot: testFixture.resourceRoot,
  }), /cannot override/);

  const linkedRoot = join(testFixture.root, "linked-resources");
  symlinkSync(testFixture.resourceRoot, linkedRoot);
  assert.throws(() => resolveDesktopResourceBoundary({
    resourcesPath: testFixture.resourcesPath,
    isPackaged: false,
    developmentResourceRoot: linkedRoot,
  }), /symbolic-link path components/);

  const nestedLinkFixture = fixture();
  const realDesktopDirectory = join(nestedLinkFixture.resourceRoot, "desktop-real");
  const originalDesktop = join(nestedLinkFixture.resourceRoot, "desktop");
  renameSync(originalDesktop, realDesktopDirectory);
  symlinkSync(realDesktopDirectory, originalDesktop);
  assert.throws(() => resolveDesktopResourceBoundary({
    resourcesPath: nestedLinkFixture.resourcesPath,
    isPackaged: false,
    developmentResourceRoot: nestedLinkFixture.resourceRoot,
  }), /symbolic-link path components/);

  const intermediateResourceFixture = fixture();
  const realParent = join(intermediateResourceFixture.root, "real-resource-parent");
  const linkedParent = join(intermediateResourceFixture.root, "linked-resource-parent");
  mkdirSync(join(realParent, "resources", "rangabot-resources", "desktop"), { recursive: true });
  writeFileSync(join(realParent, "resources", "rangabot-resources", "server.js"), "// synthetic packaged server\n");
  writeFileSync(join(realParent, "resources", "rangabot-resources", "desktop", "manifest.json"), "{}\n");
  symlinkSync(realParent, linkedParent);
  assert.throws(() => resolveDesktopResourceBoundary({
    resourcesPath: join(linkedParent, "resources"),
    isPackaged: true,
  }), /symbolic-link path components/);

  const intermediateUserDataFixture = fixture();
  const realUserParent = join(intermediateUserDataFixture.root, "real-user-parent");
  const linkedUserParent = join(intermediateUserDataFixture.root, "linked-user-parent");
  mkdirSync(realUserParent);
  symlinkSync(realUserParent, linkedUserParent);
  assert.throws(() => createDesktopRuntimeBoundary({
    resourcesPath: intermediateUserDataFixture.resourcesPath,
    userDataPath: join(linkedUserParent, "user-data"),
    isPackaged: true,
  }), /symbolic-link path components/);
});

test("desktop launch capabilities are fresh and inherited secrets/assertions are stripped", () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const hostileEnvironment = {
    PATH: "/synthetic/bin",
    OLLAMA_MODEL: "synthetic-model:1",
    NODE_OPTIONS: "--inspect",
    ELECTRON_RUN_AS_NODE: "1",
    AWS_SECRET_ACCESS_KEY: "do-not-forward",
    RANGABOT_CANDIDATE_STATE: "known",
    RANGABOT_DESKTOP_ARTIFACT_ID: "forged",
    RANGABOT_RESOURCE_ROOT: "/forged-resource",
    RANGABOT_DATA_ROOT: "/forged-data",
  };
  const first = createDesktopLaunch({ boundary, port: 43101, baseEnvironment: hostileEnvironment });
  const second = createDesktopLaunch({ boundary, port: 43102, baseEnvironment: hostileEnvironment });
  assert.equal(first.environment.RANGABOT_RESOURCE_ROOT, boundary.resourceRoot);
  assert.equal(first.environment.RANGABOT_DATA_ROOT, boundary.dataRoot);
  assert.equal(first.environment.RANGABOT_DESKTOP_MANIFEST_PATH, boundary.desktopManifestPath);
  assert.equal(first.environment.OLLAMA_MODEL, "synthetic-model:1");
  assert.equal(first.environment.NODE_OPTIONS, undefined);
  assert.equal(first.environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(first.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(first.environment.RANGABOT_CANDIDATE_STATE, undefined);
  assert.equal(first.environment.RANGABOT_DESKTOP_ARTIFACT_ID, undefined);
  assert.notEqual(first.environment.RANGABOT_SESSION_SECRET, second.environment.RANGABOT_SESSION_SECRET);
  assert.notEqual(first.environment.RANGABOT_BOOTSTRAP_TOKEN, second.environment.RANGABOT_BOOTSTRAP_TOKEN);
  assert.notEqual(first.readiness.challenge, second.readiness.challenge);
  assert.notEqual(first.readiness.secret, second.readiness.secret);
  assert.equal(first.environment.RANGABOT_DESKTOP_READINESS_CHALLENGE, first.readiness.challenge);
  assert.equal(first.environment.RANGABOT_DESKTOP_READINESS_SECRET, first.readiness.secret);
  assert.equal(verifyExpectedLocalBootstrapToken(
    first.environment.RANGABOT_BOOTSTRAP_TOKEN,
    first.environment.RANGABOT_SESSION_SECRET,
    first.environment.RANGABOT_BOOTSTRAP_TOKEN,
  ), true);
  const bootstrapUrl = new URL(first.bootstrapUrl);
  assert.equal(bootstrapUrl.origin, "http://127.0.0.1:43101");
  assert.equal(bootstrapUrl.pathname, "/bootstrap");
  assert.equal(bootstrapUrl.search, "");
  assert.equal(new URLSearchParams(bootstrapUrl.hash.slice(1)).get("bootstrap"), first.environment.RANGABOT_BOOTSTRAP_TOKEN);
});

test("operating system chooses an available IPv4 loopback port", async () => {
  const port = await reserveVerifiedLoopbackPort();
  assert.ok(port > 0 && port <= 65_535);
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, DESKTOP_LOOPBACK_HOST, resolveReady);
  });
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
});

test("desktop readiness requires authenticated proof from the supervised child and startup is bounded", async () => {
  let observedHost = "";
  let observedPath = "";
  let observedChallenge = "";
  const readiness = createDesktopReadinessCapability();
  const server = createServer((request, response) => {
    observedHost = request.headers.host ?? "";
    observedPath = request.url ?? "";
    observedChallenge = String(request.headers[DESKTOP_READINESS_CHALLENGE_HEADER.toLowerCase()] ?? "");
    response.writeHead(204, {
      [DESKTOP_READINESS_PROCESS_HEADER]: String(process.pid),
      [DESKTOP_READINESS_PROOF_HEADER]: issueDesktopReadinessProof({
        challenge: readiness.challenge,
        secret: readiness.secret,
        processId: process.pid,
      }),
    }).end();
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, DESKTOP_LOOPBACK_HOST, resolveReady);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const probeInput = { port: address.port, readiness, expectedProcessId: process.pid };
  assert.equal(await probeDesktopServer(probeInput), true);
  assert.equal(observedHost, `127.0.0.1:${address.port}`);
  assert.equal(observedPath, DESKTOP_READINESS_PATH);
  assert.equal(observedChallenge, readiness.challenge);
  await waitForDesktopServer({ ...probeInput, timeoutMs: 100, intervalMs: 1 });
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));

  const unauthenticatedServer = createServer((request, response) => {
    response.writeHead(request.url === "/bootstrap" ? 200 : 204).end();
  });
  await new Promise<void>((resolveReady, reject) => {
    unauthenticatedServer.once("error", reject);
    unauthenticatedServer.listen(0, DESKTOP_LOOPBACK_HOST, resolveReady);
  });
  const unauthenticatedAddress = unauthenticatedServer.address();
  assert.ok(unauthenticatedAddress && typeof unauthenticatedAddress !== "string");
  assert.equal(await probeDesktopServer({ ...probeInput, port: unauthenticatedAddress.port }), false,
    "an arbitrary process serving the bootstrap page is not ready");
  await new Promise<void>((resolveClose, reject) => unauthenticatedServer.close((error) => error ? reject(error) : resolveClose()));

  await assert.rejects(waitForDesktopServer({
    port: 1,
    readiness,
    expectedProcessId: process.pid,
    timeoutMs: 5,
    intervalMs: 1,
    probe: async () => false,
  }), (error: unknown) => error instanceof DesktopServerStartupError && /timeout/.test(error.message));
  await assert.rejects(waitForDesktopServer({
    port: 1,
    readiness,
    expectedProcessId: process.pid,
    timeoutMs: 100,
    intervalMs: 1,
    probe: async () => false,
    exited: Promise.resolve(),
  }), /stopped during startup/);
});

test("desktop readiness rejects a wrong process, challenge, origin and browser-shaped request", () => {
  const readiness = createDesktopReadinessCapability();
  const proof = issueDesktopReadinessProof({ ...readiness, processId: 701 });
  assert.equal(verifyDesktopReadinessProof({
    ...readiness,
    expectedProcessId: 701,
    reportedProcessId: "701",
    proof,
  }), true);
  assert.equal(verifyDesktopReadinessProof({
    ...readiness,
    expectedProcessId: 702,
    reportedProcessId: "701",
    proof,
  }), false, "a proof from a different process cannot satisfy the supervisor");
  assert.equal(verifyDesktopReadinessProof({
    challenge: createDesktopReadinessCapability().challenge,
    secret: readiness.secret,
    expectedProcessId: 701,
    reportedProcessId: "701",
    proof,
  }), false, "a proof cannot be replayed for another challenge");

  const headers = new Headers({
    host: "127.0.0.1:43127",
    "content-length": "0",
    [DESKTOP_READINESS_CHALLENGE_HEADER]: readiness.challenge,
  });
  const request = {
    desktopMode: true,
    expectedChallenge: readiness.challenge,
    port: "43127",
    url: `http://127.0.0.1:43127${DESKTOP_READINESS_PATH}`,
    method: "POST",
    headers,
  };
  assert.equal(evaluateDesktopReadinessRequest(request), true);
  assert.equal(evaluateDesktopReadinessRequest({ ...request, desktopMode: false }), false);
  assert.equal(evaluateDesktopReadinessRequest({ ...request, url: `http://localhost:43127${DESKTOP_READINESS_PATH}` }), false);
  assert.equal(evaluateDesktopReadinessRequest({
    ...request,
    headers: new Headers({ ...Object.fromEntries(headers), origin: "http://127.0.0.1:43127" }),
  }), false, "browser-shaped requests are not desktop supervisor probes");
});

test("process table traversal returns descendants deepest-first", () => {
  const table = parseProcessTable(" 100 1\n 110 100\n 120 100\n 111 110\ninvalid\n");
  assert.deepEqual(table, [
    { pid: 100, parentPid: 1 },
    { pid: 110, parentPid: 100 },
    { pid: 120, parentPid: 100 },
    { pid: 111, parentPid: 110 },
  ]);
  assert.deepEqual(descendantProcessIds(100, table), [111, 120, 110]);
});

class SyntheticUtilityProcess extends EventEmitter implements UtilityProcessLike {
  pid: number | undefined = 501;
  stdout = null;
  stderr = null;
  killed = false;
  exitOnKill = true;

  kill() {
    this.killed = true;
    if (this.exitOnKill) queueMicrotask(() => {
      this.pid = undefined;
      this.emit("exit", 0);
    });
    return true;
  }
}

test("desktop lease waits for Electron's asynchronous utility-process spawn identity", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  child.pid = undefined;
  const events: string[] = [];
  const leasedPromise = startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43102, baseEnvironment: {} }),
    acquireLease: () => ({
      registerRuntimeProcess(pid) {
        events.push(`register:${pid}`);
      },
      release() {
        events.push("release");
        return true;
      },
    }),
    fork() {
      events.push("fork");
      queueMicrotask(() => {
        events.push("spawn");
        child.pid = 502;
        child.emit("spawn");
      });
      return child;
    },
    listDescendants: async () => [],
    platform: "darwin",
  });
  assert.deepEqual(events, ["fork"]);
  const leased = await leasedPromise;
  assert.equal(leased.processId, 502);
  assert.deepEqual(events, ["fork", "spawn", "register:502"]);
  await leased.stop();
  assert.deepEqual(events, ["fork", "spawn", "register:502", "release"]);
});

test("desktop lease releases when a utility process exits before spawn", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  child.pid = undefined;
  const events: string[] = [];
  await assert.rejects(startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43101, baseEnvironment: {} }),
    acquireLease: () => ({
      registerRuntimeProcess() {
        events.push("register");
      },
      release() {
        events.push("release");
        return true;
      },
    }),
    fork() {
      queueMicrotask(() => child.emit("exit", 17));
      return child;
    },
    listDescendants: async () => [],
    platform: "darwin",
    spawnTimeoutMs: 10,
  }), /exited before spawning \(exit 17\)/);
  assert.deepEqual(events, ["release"]);
});

test("utility-process supervisor uses explicit resources and terminates the process tree", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const launch = createDesktopLaunch({ boundary, port: 43103, baseEnvironment: {} });
  const child = new SyntheticUtilityProcess();
  let forkInput: unknown[] | undefined;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const supervised = startSupervisedDesktopServer({
    fork(modulePath, args, options) {
      forkInput = [modulePath, args, options];
      return child;
    },
    boundary,
    launch,
    listDescendants: async () => [703, 702],
    inspectProcess: () => "dead",
    sendSignal(pid, signal) {
      signals.push([pid, signal as NodeJS.Signals]);
      return true;
    },
    platform: "darwin",
  });
  assert.equal(forkInput?.[0], boundary.serverEntrypoint);
  assert.deepEqual(forkInput?.[1], []);
  const options = forkInput?.[2] as { cwd: string; env: Record<string, string>; execArgv: string[]; allowLoadingUnsignedLibraries: boolean; disclaim: boolean };
  assert.equal(options.cwd, boundary.resourceRoot);
  assert.equal(options.env.RANGABOT_DATA_ROOT, boundary.dataRoot);
  assert.deepEqual(options.execArgv, []);
  assert.equal(options.allowLoadingUnsignedLibraries, false);
  assert.equal(options.disclaim, false);
  await supervised.stop();
  assert.deepEqual(signals, [[703, "SIGTERM"], [702, "SIGTERM"]]);
  assert.equal(child.killed, true);
  assert.deepEqual(await supervised.exit, { code: 0 });
});

test("utility-process supervisor force-kills a process tree that ignores graceful termination", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  child.exitOnKill = false;
  const signals: Array<[number, NodeJS.Signals]> = [];
  let descendantAlive = true;
  const supervised = startSupervisedDesktopServer({
    fork: () => child,
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43104, baseEnvironment: {} }),
    listDescendants: async () => [701],
    sendSignal(pid, signal) {
      signals.push([pid, signal as NodeJS.Signals]);
      if (pid === 701 && signal === "SIGKILL") descendantAlive = false;
      if (pid === 501 && signal === "SIGKILL") queueMicrotask(() => {
        child.pid = undefined;
        child.emit("exit", 137);
      });
      return true;
    },
    inspectProcess: (pid) => pid === 701 && descendantAlive ? "alive" : "dead",
    platform: "darwin",
    gracefulTimeoutMs: 1,
    forceTimeoutMs: 10,
  });
  await supervised.stop();
  assert.deepEqual(signals, [[701, "SIGTERM"], [701, "SIGKILL"], [501, "SIGKILL"]]);
  assert.deepEqual(await supervised.exit, { code: 137 });
});

test("Windows utility-process supervisor terminates the complete tree and force-falls back", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  child.exitOnKill = false;
  const calls: boolean[] = [];
  const supervised = startSupervisedDesktopServer({
    fork: () => child,
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43114, baseEnvironment: {} }),
    platform: "win32",
    terminateWindowsTree: async (_pid, force) => {
      calls.push(force);
      if (force) queueMicrotask(() => child.emit("exit", 1));
    },
    gracefulTimeoutMs: 1,
    forceTimeoutMs: 20,
  });
  await supervised.stop();
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(await supervised.exit, { code: 1 });

  const stuck = new SyntheticUtilityProcess();
  stuck.exitOnKill = false;
  const stuckSupervisor = startSupervisedDesktopServer({
    fork: () => stuck,
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43115, baseEnvironment: {} }),
    platform: "win32",
    terminateWindowsTree: async () => undefined,
    gracefulTimeoutMs: 1,
    forceTimeoutMs: 1,
  });
  await assert.rejects(stuckSupervisor.stop(), /process tree did not terminate/);
});

test("desktop lease is acquired before fork, binds the utility PID and releases after confirmed stop", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  const events: string[] = [];
  child.once("exit", () => events.push("exit"));
  let released = false;
  const leased = await startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43105, baseEnvironment: {} }),
    acquireLease(options) {
      events.push("acquire");
      assert.equal(options.path, desktopRuntimeLeasePath(boundary.dataRoot));
      assert.equal(options.trustedRoot, boundary.dataRoot);
      assert.equal(options.role, "app");
      return {
        registerRuntimeProcess(pid) {
          events.push("register");
          assert.equal(pid, child.pid);
        },
        release() {
          assert.equal(events.at(-1), "exit");
          events.push("release");
          released = true;
          return true;
        },
      };
    },
    fork() {
      assert.deepEqual(events, ["acquire"]);
      events.push("fork");
      return child;
    },
    listDescendants: async () => [],
    platform: "darwin",
  });
  assert.equal(leased.leasePath, join(boundary.dataRoot, "rangabot.db-runtime.lock"));
  assert.deepEqual(events, ["acquire", "fork", "register"]);
  const firstStop = leased.stop();
  const secondStop = leased.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(released, true);
  assert.deepEqual(events, ["acquire", "fork", "register", "exit", "release"]);
});

test("an active desktop runtime lease prevents a second database writer before fork", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const first = await startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43106, baseEnvironment: {} }),
    fork: () => new SyntheticUtilityProcess(),
    listDescendants: async () => [],
    platform: "darwin",
  });
  assert.equal(existsSync(first.leasePath), true);
  let forked = false;
  await assert.rejects(startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43107, baseEnvironment: {} }),
    fork() {
      forked = true;
      return new SyntheticUtilityProcess();
    },
  }), /already running/);
  assert.equal(forked, false);
  await first.stop();
  assert.equal(existsSync(first.leasePath), false);
});

test("lease registration failure stops the utility process before releasing the lease", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  const events: string[] = [];
  child.once("exit", () => events.push("exit"));
  await assert.rejects(startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43108, baseEnvironment: {} }),
    acquireLease() {
      return {
        registerRuntimeProcess() {
          events.push("register-failed");
          throw new Error("synthetic lease registration failure");
        },
        release() {
          assert.equal(events.at(-1), "exit");
          events.push("release");
          return true;
        },
      };
    },
    fork: () => child,
    listDescendants: async () => [],
    platform: "darwin",
  }), /synthetic lease registration failure/);
  assert.deepEqual(events, ["register-failed", "exit", "release"]);
});

test("failed process-tree termination retains the desktop runtime lease", async () => {
  const testFixture = fixture();
  const boundary = createDesktopRuntimeBoundary({
    resourcesPath: testFixture.resourcesPath,
    userDataPath: testFixture.userDataPath,
    isPackaged: true,
  });
  const child = new SyntheticUtilityProcess();
  child.exitOnKill = false;
  let releaseCalls = 0;
  const leased = await startLeasedDesktopServer({
    boundary,
    launch: createDesktopLaunch({ boundary, port: 43109, baseEnvironment: {} }),
    acquireLease: () => ({
      registerRuntimeProcess() {},
      release() {
        releaseCalls += 1;
        return true;
      },
    }),
    fork: () => child,
    listDescendants: async () => [],
    sendSignal: () => true,
    platform: "darwin",
    gracefulTimeoutMs: 1,
    forceTimeoutMs: 1,
  });
  await assert.rejects(leased.stop(), /process tree did not terminate/);
  assert.equal(releaseCalls, 0);
  assert.equal(leased.stop(), leased.stop());
});

test("second launch restores and focuses the existing window, including during startup", () => {
  const calls: string[] = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => { calls.push("restore"); },
    show: () => { calls.push("show"); },
    focus: () => { calls.push("focus"); },
  };
  assert.equal(focusDesktopWindow(window), true);
  assert.deepEqual(calls, ["restore", "show", "focus"]);

  let readyWindow: typeof window | undefined;
  const coordinator = createSecondInstanceFocusCoordinator(() => readyWindow);
  coordinator.onSecondInstance();
  readyWindow = window;
  assert.equal(coordinator.onWindowReady(), true);
  assert.deepEqual(calls, ["restore", "show", "focus", "restore", "show", "focus"]);
  assert.equal(coordinator.onWindowReady(), false);
});

test("Ollama diagnostic never accepts non-loopback configuration", async () => {
  for (const configured of ["https://127.0.0.1:11434", "http://example.com", "http://127.0.0.1:11434/path", "not-a-url"]) {
    assert.equal(parseLoopbackOllamaUrl(configured), null);
    assert.equal((await diagnoseLocalOllama({ baseUrl: configured })).kind, "invalid-config");
  }
});

test("Ollama diagnostic distinguishes unavailable, missing and ready without downloading", async () => {
  const unusedPort = await reserveVerifiedLoopbackPort();
  const unavailable = await diagnoseLocalOllama({ baseUrl: `http://127.0.0.1:${unusedPort}`, timeoutMs: 20 });
  assert.equal(unavailable.kind, "unavailable");
  assert.match(unavailable.message, /did not connect to the internet or download anything/);

  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/tags");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ models: [{ name: "synthetic-model:1" }] }));
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, DESKTOP_LOOPBACK_HOST, resolveReady);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.equal((await diagnoseLocalOllama({ baseUrl, model: "missing-model:1" })).kind, "model-missing");
  assert.equal((await diagnoseLocalOllama({ baseUrl, model: "synthetic-model:1" })).kind, "ready");
  assert.equal(requests, 2);
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
});

test("main process statically retains fail-closed lifecycle controls", () => {
  const source = readFileSync(join(projectRoot, "desktop", "electron", "main.ts"), "utf8");
  assert.match(source, /app\.enableSandbox\(\)/);
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /utilityProcess\.fork/);
  assert.match(source, /await startLeasedDesktopServer/);
  assert.match(source, /if \(state\.stopPromise\) return state\.stopPromise/);
  assert.match(source, /showErrorBox/);
  assert.match(source, /await stopRuntime\(state\)[\s\S]*throw error/);
  assert.match(source, /before-quit/);
  assert.match(source, /const verified = input\.verifiedResources \?\? verifyDesktopResourcesBeforeMutation\([\s\S]*?electronApp\.getPath\("userData"\)[\s\S]*?reserveVerifiedLoopbackPort[\s\S]*?createDesktopRuntimeBoundaryFromVerifiedResources[\s\S]*?session\.fromPartition[\s\S]*?startLeasedDesktopServer[\s\S]*?createMainWindow/);
  assert.match(source, /initialVerification = verifyDesktopResourcesBeforeMutation\([\s\S]*?prepareDesktopStartupProfileBeforeLock\(\{[\s\S]*?app\.enableSandbox\(\)[\s\S]*?app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /RANGABOT_DESKTOP_\$\{failure \? "FAILURE" : "STAGE"\}=\$\{stage\}/);
  assert.match(source, /S10_ARTIFACT_VERIFY[\s\S]*?verifyDesktopResourcesBeforeMutation[\s\S]*?S20_PROFILE_BIND[\s\S]*?prepareDesktopStartupProfileBeforeLock/);
  assert.match(source, /reportStage\(stage\)[\s\S]*?startupPreludeStage = stage[\s\S]*?emitStartupStage\(stage\)/);
  assert.match(source, /S30_SANDBOX_ENABLE[\s\S]*?app\.enableSandbox\(\)[\s\S]*?S40_LOCK_REQUEST[\s\S]*?app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /R60_SERVER_START[\s\S]*?startLeasedDesktopServer[\s\S]*?R70_READINESS[\s\S]*?waitForDesktopServer[\s\S]*?R80_WINDOW_CREATE[\s\S]*?createMainWindow[\s\S]*?R90_WINDOW_LOAD[\s\S]*?loadURL[\s\S]*?R99_RUNNING/);
  const profile = readFileSync(join(projectRoot, "desktop", "electron", "verification-profile.ts"), "utf8");
  assert.match(profile, /validateFinderVerificationCapsuleReadOnly\(\{[\s\S]*?getPath\("appData"\)[\s\S]*?setPath\("userData"[\s\S]*?preflightVerificationExternalFilesystemRegistries/);
  const verificationBranch = profile.slice(profile.indexOf("  const capsule = validateFinderVerificationCapsuleReadOnly"));
  assert.doesNotMatch(verificationBranch, /process\.env|mkdir|chmod|writeFile|rename|unlink|rmSync/);
  assert.doesNotMatch(source, /shell\.openExternal|ELECTRON_RUN_AS_NODE|remote\./);
});
