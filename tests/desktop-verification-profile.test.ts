import assert from "node:assert/strict";
import {
  chmodSync,
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
import { join } from "node:path";
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

test("normal profile keeps its existing userData behavior and never applies verification policy", () => {
  const userDataPath = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-normal-userdata-")));
  const calls: string[] = [];
  try {
    const prepared = prepareDesktopStartupProfileBeforeLock({
      electronApp: {
        getPath(name: string) { calls.push(name); return userDataPath; },
        setPath() { throw new Error("normal profile must not override Electron paths"); },
      } as never,
      launchProfile: NORMAL_DESKTOP_LAUNCH_PROFILE,
    });
    assert.deepEqual(calls, ["userData"]);
    assert.equal(prepared.kind, "normal");
    assert.equal(prepared.verificationPolicy, undefined);
  } finally { rmSync(userDataPath, { recursive: true, force: true }); }
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
