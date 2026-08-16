import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleSquirrelStartup, parseSquirrelStartupEvent } from "../desktop/electron/squirrel-lifecycle.ts";
import { assertStableRegularFileUnchanged, inspectStableRegularFile } from "../scripts/verify-windows-distributables.ts";

const text = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Windows package inputs are exact, platform-typed, and contain no model weights", () => {
  const packageRecord = JSON.parse(text("package.json")) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
  assert.equal(packageRecord.devDependencies["@electron-forge/maker-squirrel"], "7.11.2");
  assert.match(packageRecord.scripts["desktop:make:windows:x64"], /--platform=win32 --arch=x64/);
  const prepare = text("scripts/prepare-desktop.ts");
  assert.match(prepare, /7b4f6ce09c1f2c3b21561b323779beaf3ca3c7012f8e4522605a13cbbb19f0b8/);
  assert.match(prepare, /ef0709cfa719739acce73de6f9b684304baf38c6454376638a70d34a7cecffe0/);
  assert.match(prepare, /ollama-windows-amd64\.zip/);
  assert.match(prepare, /\.gguf\|\\\.ggml\|\\\.safetensors/);
  assert.match(prepare, /verification \? "packaged-resources-verification" : "packaged-resources", target\.platform, arch/);
});

test("Forge creates Windows ZIP and per-user Squirrel outputs with the Windows icon and PE fuse target", () => {
  const forge = text("forge.config.cjs");
  assert.match(forge, /new MakerZIP\(\{\}, \["win32"\]\)/);
  assert.match(forge, /new MakerSquirrel/);
  assert.match(forge, /RangaBot-win32-x64-Setup\.exe/);
  assert.match(forge, /path\.resolve\(outputPath, "RangaBot\.exe"\)/);
  assert.match(forge, /packageAfterCopy:[\s\S]*if \(platform === "darwin"\)/);
  assert.match(forge, /postPackage:[\s\S]*finalizePackagedExecutables/);
  assert.match(forge, /if \(status === "NotSigned"\) return/);
  assert.match(forge, /status !== "HashMismatch"/);
  assert.match(forge, /windowsSignTool\(\), \["remove", "\/s", "\/q", executable\]/);
  assert.match(forge, /Authenticode removal changed the Electron fuse wire/);
  const icon = readFileSync(new URL("../desktop/assets/rangabot.ico", import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 7);
});

test("Squirrel actions run only after immutable verification and before profile binding", () => {
  assert.equal(parseSquirrelStartupEvent(["RangaBot.exe", "--squirrel-install"]), "--squirrel-install");
  assert.equal(parseSquirrelStartupEvent(["RangaBot.exe", "--not-squirrel"]), null);
  let exitCode: number | undefined;
  assert.equal(handleSquirrelStartup({ platform: "win32", event: "--squirrel-obsolete", exit: (code) => { exitCode = code; } }), true);
  assert.equal(exitCode, 0);
  const main = text("desktop/electron/main.ts");
  const verify = main.lastIndexOf("verifyDesktopResourcesBeforeMutation({");
  const squirrel = main.lastIndexOf("handleSquirrelStartup({");
  const profile = main.lastIndexOf("prepareDesktopStartupProfileBeforeLock({");
  assert.ok(verify >= 0 && verify < squirrel && squirrel < profile);
  assert.match(main, /com\.squirrel\.RangaBot\.RangaBot/);
});

test("Squirrel shortcut lifecycle handles install, update, uninstall, and failures deterministically", () => {
  const executablePath = "C:\\Users\\Synthetic\\AppData\\Local\\RangaBot\\app-0.1.0\\RangaBot.exe";
  const calls: Array<{ path: string; arguments_: readonly string[]; cwd: string }> = [];
  const inspectUpdateExecutable = () => ({ isSymbolicLink: () => false, isFile: () => true });
  const runUpdateExecutable = (path: string, arguments_: readonly string[], options: { cwd: string }) => {
    calls.push({ path, arguments_, cwd: options.cwd });
    return { status: 0, signal: null };
  };
  for (const [event, expected] of [
    ["--squirrel-install", "--createShortcut"],
    ["--squirrel-updated", "--createShortcut"],
    ["--squirrel-uninstall", "--removeShortcut"],
  ] as const) {
    let exitCode: number | undefined;
    assert.equal(handleSquirrelStartup({
      platform: "win32",
      event,
      executablePath,
      inspectUpdateExecutable,
      runUpdateExecutable,
      exit: (code) => { exitCode = code; },
    }), true);
    assert.equal(exitCode, 0);
    assert.deepEqual(calls.at(-1)?.arguments_, [expected, "RangaBot.exe"]);
  }
  assert.ok(calls.every((call) => (
    call.path === "C:\\Users\\Synthetic\\AppData\\Local\\RangaBot\\Update.exe"
      && call.cwd === "C:\\Users\\Synthetic\\AppData\\Local\\RangaBot"
  )));

  let exitCode: number | undefined;
  handleSquirrelStartup({
    platform: "win32",
    event: "--squirrel-install",
    executablePath,
    inspectUpdateExecutable,
    runUpdateExecutable: () => ({ status: 1, signal: null }),
    exit: (code) => { exitCode = code; },
  });
  assert.equal(exitCode, 1);
});

test("Windows finalizer seals PE/native/fuse evidence but keeps unsigned candidates non-release", () => {
  const finalizer = text("scripts/finalize-desktop-package.ts");
  assert.match(finalizer, /mode: "unsigned-candidate", postFuseMutation: true, deepStrictVerified: false/);
  assert.match(finalizer, /verified\.reason !== "distribution-unsigned"/);
  assert.match(finalizer, /assertWindowsAuthenticodeNotSigned\(executable\)/);
  assert.match(finalizer, /runtime\/ollama\/ollama\.exe/);
  assert.match(finalizer, /node\|dll\|so\|dylib\|exe/);
  assert.match(finalizer, /\.gguf\|\\\.ggml\|\\\.safetensors/);
  assert.match(text("scripts/verify-windows-distributables.ts"), /applicationSignatureStatus !== "NotSigned"/);
  const workflow = text(".github/workflows/windows-desktop-candidate.yml");
  assert.match(workflow, /npm audit --omit=dev/);
  assert.doesNotMatch(workflow, /release create|upload-release-asset/i);
});

test("Windows distributable evidence rejects links and detects post-hash replacement", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-windows-evidence-")));
  const artifact = join(root, "candidate.exe");
  const linkedDirectory = join(root, "linked-candidate.exe");
  const targetDirectory = join(root, "target");
  try {
    writeFileSync(artifact, "sealed candidate bytes\n");
    const evidence = inspectStableRegularFile(artifact, { label: "Synthetic candidate", captureContent: true });
    assert.equal(evidence.content?.toString("utf8"), "sealed candidate bytes\n");
    assertStableRegularFileUnchanged(artifact, evidence, "Synthetic candidate");

    writeFileSync(artifact, "changed candidate bytes\n");
    assert.throws(
      () => assertStableRegularFileUnchanged(artifact, evidence, "Synthetic candidate"),
      /changed after it was inspected/,
    );

    mkdirSync(targetDirectory);
    symlinkSync(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => inspectStableRegularFile(linkedDirectory, { label: "Linked candidate" }),
      /real, non-linked regular file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
