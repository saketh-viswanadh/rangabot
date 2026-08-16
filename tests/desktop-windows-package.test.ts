import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleSquirrelStartup, parseSquirrelStartupEvent } from "../desktop/electron/squirrel-lifecycle.ts";
import { assertStableRegularFileUnchanged, inspectStableRegularFile } from "../scripts/verify-windows-distributables.ts";

const text = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const {
  assertWindowsPeCertificateTableAbsent,
  inspectWindowsPeCertificateTable,
  inspectWindowsPeCertificateTableBuffer,
} = require("../desktop/electron/windows-pe-certificate.cjs") as {
  assertWindowsPeCertificateTableAbsent(path: string, label?: string): Readonly<{ embeddedPeCertificateTable: "absent" }>;
  inspectWindowsPeCertificateTable(path: string, label?: string): Readonly<{ embeddedPeCertificateTable: "absent" | "present" }>;
  inspectWindowsPeCertificateTableBuffer(source: Buffer, label?: string): Readonly<{
    format: "PE32" | "PE32+";
    embeddedPeCertificateTable: "absent" | "present";
  }>;
};

function syntheticWindowsPe(input: {
  format?: "PE32" | "PE32+";
  directoryCount?: number;
  certificateTableOffset?: number;
  certificateTableBytes?: number;
} = {}) {
  const format = input.format ?? "PE32+";
  const source = Buffer.alloc(1024);
  const peOffset = 128;
  const optionalHeaderOffset = peOffset + 24;
  const directoryCountOffset = format === "PE32+" ? 108 : 92;
  const directoryStartOffset = format === "PE32+" ? 112 : 96;
  source.writeUInt16LE(0x5a4d, 0);
  source.writeUInt32LE(peOffset, 0x3c);
  source.writeUInt32LE(0x00004550, peOffset);
  source.writeUInt16LE(format === "PE32+" ? 0x8664 : 0x014c, peOffset + 4);
  source.writeUInt16LE(format === "PE32+" ? 240 : 224, peOffset + 20);
  source.writeUInt16LE(format === "PE32+" ? 0x20b : 0x10b, optionalHeaderOffset);
  const directoryCount = input.directoryCount ?? 16;
  source.writeUInt32LE(directoryCount, optionalHeaderOffset + directoryCountOffset);
  if (directoryCount > 4) {
    source.writeUInt32LE(input.certificateTableOffset ?? 0, optionalHeaderOffset + directoryStartOffset + 32);
    source.writeUInt32LE(input.certificateTableBytes ?? 0, optionalHeaderOffset + directoryStartOffset + 36);
  }
  return source;
}

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
  assert.match(forge, /assertWindowsPeCertificateTableAbsent\(executable, "Fuse-mutated RangaBot\.exe"\)/);
  assert.doesNotMatch(forge, /Get-AuthenticodeSignature|powershell\.exe|signtool|HashMismatch/);
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

test("Windows unsigned policy directly rejects embedded PE certificate tables", () => {
  assert.equal(inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe()).embeddedPeCertificateTable, "absent");
  assert.equal(inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ format: "PE32" })).format, "PE32");
  assert.equal(inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ directoryCount: 4 })).embeddedPeCertificateTable, "absent");
  const present = syntheticWindowsPe({ certificateTableOffset: 768, certificateTableBytes: 32 });
  assert.equal(inspectWindowsPeCertificateTableBuffer(present).embeddedPeCertificateTable, "present");
  assert.throws(
    () => inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ certificateTableOffset: 768, certificateTableBytes: 0 })),
    /inconsistent embedded certificate-table entry/,
  );
  assert.throws(
    () => inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ certificateTableOffset: 0, certificateTableBytes: 32 })),
    /inconsistent embedded certificate-table entry/,
  );
  assert.throws(
    () => inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ certificateTableOffset: 769, certificateTableBytes: 32 })),
    /malformed embedded certificate table/,
  );
  assert.throws(
    () => inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ certificateTableOffset: 768, certificateTableBytes: 4 })),
    /malformed embedded certificate table/,
  );
  assert.throws(
    () => inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ certificateTableOffset: 1000, certificateTableBytes: 32 })),
    /out-of-bounds embedded certificate table/,
  );
  const wrongMachine = syntheticWindowsPe();
  wrongMachine.writeUInt16LE(0xaa64, 132);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(wrongMachine), /unsupported PE machine/);
  const badMz = syntheticWindowsPe();
  badMz.writeUInt16LE(0, 0);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(badMz), /missing the MZ header/);
  const badPe = syntheticWindowsPe();
  badPe.writeUInt32LE(0, 128);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(badPe), /missing the PE signature/);
  const unsupportedMagic = syntheticWindowsPe();
  unsupportedMagic.writeUInt16LE(0x107, 152);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(unsupportedMagic), /unsupported PE optional-header format/);
  const wrongMagic = syntheticWindowsPe();
  wrongMagic.writeUInt16LE(0x10b, 152);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(wrongMagic), /inconsistent PE machine/);
  const truncatedOptionalHeader = syntheticWindowsPe();
  truncatedOptionalHeader.writeUInt16LE(110, 148);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(truncatedOptionalHeader), /complete data-directory count/);
  const overlappingHeader = syntheticWindowsPe();
  overlappingHeader.writeUInt32LE(2, 0x3c);
  assert.throws(() => inspectWindowsPeCertificateTableBuffer(overlappingHeader), /out-of-bounds PE header/);
  assert.throws(
    () => inspectWindowsPeCertificateTableBuffer(syntheticWindowsPe({ directoryCount: 17 })),
    /data directories outside its optional header/,
  );

  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-pe-certificate-")));
  const unsignedPath = join(root, "unsigned.exe");
  const signedPath = join(root, "signed.exe");
  const linkedPath = join(root, "linked.exe");
  try {
    writeFileSync(unsignedPath, syntheticWindowsPe());
    writeFileSync(signedPath, present);
    assert.equal(assertWindowsPeCertificateTableAbsent(unsignedPath).embeddedPeCertificateTable, "absent");
    assert.equal(inspectWindowsPeCertificateTable(signedPath).embeddedPeCertificateTable, "present");
    assert.throws(() => assertWindowsPeCertificateTableAbsent(signedPath), /contains an embedded PE certificate table/);
    symlinkSync(unsignedPath, linkedPath, "file");
    assert.throws(() => inspectWindowsPeCertificateTable(linkedPath), /stable, non-linked regular PE file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows finalizer seals PE/native/fuse evidence but keeps unsigned candidates non-release", () => {
  const finalizer = text("scripts/finalize-desktop-package.ts");
  assert.match(finalizer, /mode: "unsigned-candidate", postFuseMutation: true, deepStrictVerified: false/);
  assert.match(finalizer, /verified\.reason !== "distribution-unsigned"/);
  assert.match(finalizer, /assertWindowsPeCertificateTableAbsent\(executable, "Final RangaBot\.exe"\)/);
  assert.match(finalizer, /runtime\/ollama\/ollama\.exe/);
  assert.match(finalizer, /node\|dll\|so\|dylib\|exe/);
  assert.match(finalizer, /\.gguf\|\\\.ggml\|\\\.safetensors/);
  const verifier = text("scripts/verify-windows-distributables.ts");
  assert.match(verifier, /applicationEmbeddedPeCertificateTable/);
  assert.doesNotMatch(`${finalizer}\n${verifier}`, /Get-AuthenticodeSignature|powershell\.exe|applicationSignatureStatus/);
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
