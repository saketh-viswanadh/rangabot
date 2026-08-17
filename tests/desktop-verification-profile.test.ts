import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  desktopLaunchProfileForBuild,
  DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE,
  FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE,
  finderVerificationCapsuleMarkerBytes,
  NORMAL_DESKTOP_LAUNCH_PROFILE,
  parseDesktopLaunchProfile,
  validateFinderVerificationCapsuleReadOnly,
} from "../lib/desktop-launch-profile.ts";
import { prepareDesktopStartupProfileBeforeLock } from "../desktop/electron/verification-profile.ts";
import { ensurePrivateDesktopDataRoot } from "../desktop/electron/resource-boundary.ts";
import { selectManagedModelStore } from "../desktop/electron/model-runtime.ts";
import {
  prepareWindowsInternalMsixDataPaths,
  WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME,
  WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME,
  WINDOWS_INTERNAL_MSIX_PACKAGE_NAME,
  WINDOWS_INTERNAL_MSIX_PACKAGE_VERSION,
  WINDOWS_INTERNAL_MSIX_PUBLISHER_ID,
} from "../desktop/electron/windows-packaged-data-root.ts";

function createCapsule() {
  const appDataPath = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-appdata-")));
  const profile = FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE;
  const capsuleRoot = join(appDataPath, ...profile.applicationSupportRelativePath.split("/"));
  const userDataPath = join(capsuleRoot, "userData");
  const dataRoot = join(userDataPath, "private-data");
  const paths = [
    capsuleRoot,
    userDataPath,
    dataRoot,
    join(dataRoot, "tmp"),
    join(capsuleRoot, "sessionData"),
    join(capsuleRoot, "logs"),
    join(capsuleRoot, "crashDumps"),
  ];
  for (const path of paths) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  writeFileSync(join(capsuleRoot, "capsule-profile.json"), finderVerificationCapsuleMarkerBytes(), { mode: 0o600 });
  return { appDataPath, capsuleRoot, userDataPath, dataRoot };
}

test("Finder verification profile is exact, sealed, and not a general runtime selector", () => {
  assert.deepEqual(desktopLaunchProfileForBuild(undefined), NORMAL_DESKTOP_LAUNCH_PROFILE);
  assert.deepEqual(desktopLaunchProfileForBuild(DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE),
    FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE);
  assert.deepEqual(parseDesktopLaunchProfile(JSON.parse(JSON.stringify(FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE))),
    FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE);
  assert.equal(parseDesktopLaunchProfile({ ...FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE, profileId: "forged" }), null);
  assert.throws(() => desktopLaunchProfileForBuild("arbitrary"), /not recognized/);
});

test("pre-created capsule validates read-only and binds all Electron writable paths before lock", () => {
  const fixture = createCapsule();
  const setPaths: Array<[string, string]> = [];
  try {
    const prepared = prepareDesktopStartupProfileBeforeLock({
      electronApp: {
        getPath(name: string) {
          assert.equal(name, "appData");
          return fixture.appDataPath;
        },
        setPath(name: string, path: string) { setPaths.push([name, path]); },
      } as never,
      launchProfile: FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE,
      isPackaged: true,
      platform: "darwin",
      windowsStore: false,
    });
    assert.equal(prepared.kind, DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE);
    assert.equal(prepared.windowTitle, "Rangabot Verification");
    assert.equal(prepared.userDataPath, fixture.userDataPath);
    assert.deepEqual(prepared.verificationPolicy, { externalFilesystemAccess: "deny", localModelPolicy: "disabled" });
    assert.deepEqual(setPaths, [
      ["userData", fixture.userDataPath],
      ["sessionData", join(fixture.capsuleRoot, "sessionData")],
      ["logs", join(fixture.capsuleRoot, "logs")],
      ["crashDumps", join(fixture.capsuleRoot, "crashDumps")],
    ]);
    assert.deepEqual(readdirSync(fixture.dataRoot), ["tmp"]);
  } finally { rmSync(fixture.appDataPath, { recursive: true, force: true }); }
});

test("capsule validation rejects missing, unexpected, unsafe-mode, marker, and symlinked content without provisioning", () => {
  const missingAppData = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-missing-")));
  try {
    const before = readdirSync(missingAppData);
    assert.throws(() => validateFinderVerificationCapsuleReadOnly({
      appDataPath: missingAppData,
      profile: FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE,
    }));
    assert.deepEqual(readdirSync(missingAppData), before);
  } finally { rmSync(missingAppData, { recursive: true, force: true }); }

  const mutations = [
    (fixture: ReturnType<typeof createCapsule>) => writeFileSync(join(fixture.capsuleRoot, "unexpected"), "x", { mode: 0o600 }),
    (fixture: ReturnType<typeof createCapsule>) => writeFileSync(join(fixture.capsuleRoot, "capsule-profile.json"), "{}\n", { mode: 0o600 }),
    (fixture: ReturnType<typeof createCapsule>) => symlinkSync(join(fixture.capsuleRoot, "logs"), join(fixture.capsuleRoot, "sessionData", "escape")),
  ];
  if (process.platform !== "win32") {
    mutations.push((fixture: ReturnType<typeof createCapsule>) => chmodSync(join(fixture.capsuleRoot, "logs"), 0o755));
  }
  for (const mutate of mutations) {
    const fixture = createCapsule();
    try {
      mutate(fixture);
      assert.throws(() => validateFinderVerificationCapsuleReadOnly({
        appDataPath: fixture.appDataPath,
        profile: FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE,
      }));
    } finally { rmSync(fixture.appDataPath, { recursive: true, force: true }); }
  }
});

test("unpackaged normal profile keeps its existing userData behavior and never applies verification policy", () => {
  const userDataPath = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-normal-userdata-")));
  const calls: string[] = [];
  try {
    const prepared = prepareDesktopStartupProfileBeforeLock({
      electronApp: {
        getPath(name: string) { calls.push(name); return userDataPath; },
        setPath() { throw new Error("normal profile must not override Electron paths"); },
      } as never,
      launchProfile: NORMAL_DESKTOP_LAUNCH_PROFILE,
      isPackaged: false,
      platform: "win32",
      windowsStore: false,
    });
    assert.deepEqual(calls, ["userData"]);
    assert.equal(prepared.kind, "normal");
    assert.equal(prepared.verificationPolicy, undefined);
  } finally { rmSync(userDataPath, { recursive: true, force: true }); }
});

function createInternalMsixDataFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-msix-data-")));
  const appDataRoot = join(root, "User", "AppData");
  const appDataPath = join(appDataRoot, "Roaming");
  const localAppDataPath = join(appDataRoot, "Local");
  const packageFamilyRoot = join(localAppDataPath, "Packages", WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME);
  const localState = join(packageFamilyRoot, "LocalState");
  const localCache = join(packageFamilyRoot, "LocalCache");
  const packageInstallRoot = join(root, "WindowsApps", WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME);
  const execPath = join(packageInstallRoot, "RangaBot.exe");
  mkdirSync(appDataPath, { recursive: true, mode: 0o700 });
  mkdirSync(localState, { recursive: true, mode: 0o700 });
  mkdirSync(localCache, { mode: 0o700 });
  mkdirSync(packageInstallRoot, { recursive: true, mode: 0o700 });
  writeFileSync(execPath, "synthetic internal MSIX executable\n", { mode: 0o700 });
  return { root, appDataPath, localAppDataPath, packageFamilyRoot, localState, localCache, packageInstallRoot, execPath };
}

test("internal MSIX binds exact LocalState without resolving or reading legacy unpackaged userData", () => {
  const fixture = createInternalMsixDataFixture();
  const legacyUserData = join(fixture.appDataPath, "Rangabot");
  const legacySentinel = join(legacyUserData, "legacy-sentinel.txt");
  const setPaths: Array<[string, string]> = [];
  try {
    mkdirSync(legacyUserData, { recursive: true, mode: 0o700 });
    writeFileSync(legacySentinel, "legacy data must remain isolated\n", { mode: 0o600 });
    const prepared = prepareDesktopStartupProfileBeforeLock({
      electronApp: {
        getPath(name: string) {
          assert.equal(name, "appData");
          return fixture.appDataPath;
        },
        setPath(name: string, path: string) { setPaths.push([name, path]); },
      } as never,
      launchProfile: NORMAL_DESKTOP_LAUNCH_PROFILE,
      isPackaged: true,
      platform: "win32",
      windowsStore: true,
      localAppDataPath: fixture.localAppDataPath,
      execPath: fixture.execPath,
    });
    const expectedUserData = join(fixture.localState, "RangaBot");
    const expectedSessionData = join(fixture.localCache, "RangaBot", "sessionData");
    assert.equal(prepared.userDataPath, expectedUserData);
    assert.deepEqual(setPaths, [
      ["userData", expectedUserData],
      ["sessionData", expectedSessionData],
      ["logs", join(expectedUserData, "logs")],
      ["crashDumps", join(expectedUserData, "crashDumps")],
    ]);
    for (const [, path] of setPaths) assert.equal(realpathSync(path), path);
    assert.equal(readFileSync(legacySentinel, "utf8"), "legacy data must remain isolated\n");

    const dataRoot = ensurePrivateDesktopDataRoot(prepared.userDataPath);
    const fallbackModels = join(dataRoot, "models");
    assert.equal(selectManagedModelStore({ privateModelsRoot: fallbackModels, platform: "win32" }), fallbackModels);
    assert.equal(realpathSync(fallbackModels), fallbackModels);
    assert.equal(readFileSync(legacySentinel, "utf8"), "legacy data must remain isolated\n");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("internal MSIX identity and LocalState binding are exact and fail closed on unsafe paths", () => {
  const manifest = readFileSync(new URL("../desktop/msix/AppxManifest.xml", import.meta.url), "utf8");
  const identity = manifest.match(/<Identity\b[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(identity, new RegExp(`Name="${WINDOWS_INTERNAL_MSIX_PACKAGE_NAME.replaceAll(".", "\\.")}"`));
  assert.match(identity, /Publisher="CN=RangaBot Internal Candidate, OID\.2\.25\.311729368913984317654407730594956997722=1"/);
  assert.equal(WINDOWS_INTERNAL_MSIX_PUBLISHER_ID, "d8tfa9dph86fg");
  assert.equal(WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME, "RangaBot.InternalCandidate_d8tfa9dph86fg");
  assert.equal(WINDOWS_INTERNAL_MSIX_PACKAGE_VERSION, "0.1.0.0");
  assert.equal(
    WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME,
    "RangaBot.InternalCandidate_0.1.0.0_x64__d8tfa9dph86fg",
  );
  assert.match(identity, new RegExp(`Version="${WINDOWS_INTERNAL_MSIX_PACKAGE_VERSION.replaceAll(".", "\\.")}"`));

  const fixture = createInternalMsixDataFixture();
  try {
    assert.deepEqual(prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath: fixture.appDataPath,
      localAppDataPath: fixture.localAppDataPath,
      execPath: fixture.execPath,
    }), {
      userDataPath: join(fixture.localState, "RangaBot"),
      sessionDataPath: join(fixture.localCache, "RangaBot", "sessionData"),
      logsPath: join(fixture.localState, "RangaBot", "logs"),
      crashDumpsPath: join(fixture.localState, "RangaBot", "crashDumps"),
    });
    assert.equal(prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: false,
      isPackaged: true,
    }), null);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: false,
      appDataPath: fixture.appDataPath,
      localAppDataPath: fixture.localAppDataPath,
      execPath: fixture.execPath,
    }), /inconsistent Windows MSIX runtime identity/);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      localAppDataPath: fixture.localAppDataPath,
      execPath: fixture.execPath,
    }), /Electron appData is unavailable/);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath: fixture.appDataPath,
      execPath: fixture.execPath,
    }), /LOCALAPPDATA is unavailable/);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath: fixture.appDataPath,
      localAppDataPath: `${fixture.localAppDataPath}${sep}.`,
      execPath: fixture.execPath,
    }), /absolute normalized path/);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath: fixture.appDataPath,
      localAppDataPath: fixture.localAppDataPath,
    }), /executable path is unavailable/);

    const wrongInstallRoot = join(fixture.root, "WindowsApps", "Wrong.Package_0.1.0.0_x64__d8tfa9dph86fg");
    const wrongExecPath = join(wrongInstallRoot, "RangaBot.exe");
    mkdirSync(wrongInstallRoot, { recursive: true });
    writeFileSync(wrongExecPath, "wrong package identity\n");
    rmSync(join(fixture.localState, "RangaBot"), { recursive: true, force: true });
    rmSync(join(fixture.localCache, "RangaBot"), { recursive: true, force: true });
    const redirectedLocalAppData = join(fixture.root, "redirected-local-app-data");
    mkdirSync(redirectedLocalAppData);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath: fixture.appDataPath,
      localAppDataPath: redirectedLocalAppData,
      execPath: fixture.execPath,
    }), /does not match Electron's OS-derived local AppData path/);
    assert.equal(existsSync(join(fixture.localState, "RangaBot")), false);
    assert.equal(existsSync(join(fixture.localCache, "RangaBot")), false);
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath: fixture.appDataPath,
      localAppDataPath: fixture.localAppDataPath,
      execPath: wrongExecPath,
    }), /package full name does not match/);
    assert.equal(existsSync(join(fixture.localState, "RangaBot")), false);
    assert.equal(existsSync(join(fixture.localCache, "RangaBot")), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }

  const linkedRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-msix-linked-data-")));
  try {
    const appDataRoot = join(linkedRoot, "User", "AppData");
    const appDataPath = join(appDataRoot, "Roaming");
    const localAppDataPath = join(appDataRoot, "Local");
    const actualPackages = join(linkedRoot, "actual-packages");
    const installRoot = join(linkedRoot, "WindowsApps", WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME);
    const execPath = join(installRoot, "RangaBot.exe");
    mkdirSync(join(actualPackages, WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME, "LocalState"), { recursive: true });
    mkdirSync(join(actualPackages, WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME, "LocalCache"));
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(execPath, "synthetic executable\n");
    mkdirSync(appDataPath, { recursive: true });
    mkdirSync(localAppDataPath);
    symlinkSync(actualPackages, join(localAppDataPath, "Packages"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath,
      localAppDataPath,
      execPath,
    }), /symbolic-link or junction components/);
  } finally { rmSync(linkedRoot, { recursive: true, force: true }); }

  const fileRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-msix-file-data-")));
  try {
    const appDataRoot = join(fileRoot, "User", "AppData");
    const appDataPath = join(appDataRoot, "Roaming");
    const localAppDataPath = join(appDataRoot, "Local");
    const family = join(localAppDataPath, "Packages", WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME);
    const installRoot = join(fileRoot, "WindowsApps", WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME);
    const execPath = join(installRoot, "RangaBot.exe");
    mkdirSync(appDataPath, { recursive: true });
    mkdirSync(family, { recursive: true });
    mkdirSync(join(family, "LocalCache"));
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(execPath, "synthetic executable\n");
    writeFileSync(join(family, "LocalState"), "not a directory\n");
    assert.throws(() => prepareWindowsInternalMsixDataPaths({
      platform: "win32",
      windowsStore: true,
      isPackaged: true,
      appDataPath,
      localAppDataPath,
      execPath,
    }), /must be a real directory/);
    assert.equal(existsSync(join(appDataPath, "Rangabot")), false);
  } finally { rmSync(fileRoot, { recursive: true, force: true }); }
});

test("source and packaging preserve fail-before-write ordering and distinct verification outputs", () => {
  const main = readFileSync(new URL("../desktop/electron/main.ts", import.meta.url), "utf8");
  assert.ok(main.lastIndexOf("verifyDesktopResourcesBeforeMutation") < main.indexOf("prepareDesktopStartupProfileBeforeLock({"));
  assert.ok(main.indexOf("prepareDesktopStartupProfileBeforeLock({") < main.indexOf("app.requestSingleInstanceLock()"));
  assert.ok(main.indexOf("app.requestSingleInstanceLock()") < main.lastIndexOf("startDesktopRuntime({"));
  assert.doesNotMatch(main, /RANGABOT_DESKTOP_BUILD_PROFILE|process\.env\[[^\]]*PROFILE/);

  const prepare = readFileSync(new URL("../scripts/prepare-desktop.ts", import.meta.url), "utf8");
  assert.doesNotMatch(prepare, /removeGeneratedOutput\(resolve\(projectRoot, "out"\)\)/);
  assert.match(prepare, /rmSync\(resolve\(resourceRoot, "out"\)/);
  assert.match(prepare, /rmSync\(resolve\(resourceRoot, "desktop"\)/);
  assert.match(prepare, /rmSync\(resolve\(resourceRoot, "tests"\)/);
  assert.match(prepare, /assertNoPrivatePayload\(resources\)/);
  assert.match(prepare, /\^\(\?:out\|desktop\)/);
  assert.match(prepare, /RangaBot Verification/);
  const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(nextConfig, /outputFileTracingExcludes:\s*\{\s*"\/\*": \["\.\/tests\/\*\*\/\*"\]/);
  const finalizer = readFileSync(new URL("../scripts/finalize-desktop-package.ts", import.meta.url), "utf8");
  assert.match(finalizer, /desktop-artifact-verification-/);
  assert.match(finalizer, /desktop-artifact-normal-refresh-20260812-/);
  const forge = readFileSync(new URL("../forge.config.cjs", import.meta.url), "utf8");
  assert.match(forge, /com\.rangabot\.desktop\.verification/);
  assert.match(forge, /RangaBot Verification/);
  assert.match(forge, /normal-candidate-20260812/);

  const packageRecord = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = packageRecord.scripts["desktop:package:normal-refresh:arm64"];
  assert.match(command, /RANGABOT_DESKTOP_PACKAGE_VARIANT=normal-refresh-20260812-v1/);
  assert.doesNotMatch(command, /RANGABOT_DESKTOP_BUILD_PROFILE/);
});
