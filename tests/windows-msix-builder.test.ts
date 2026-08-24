import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  constants,
  mkdtempSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  APPROVED_MSIX_MANIFEST_SHA256,
  assertPinnedWindowsToolRootStrings,
  buildUnsignedMsix,
  collectMsixSourceInventory,
  createMakeAppxMapping,
  inspectPinnedMakeAppx,
  makeAppxPowerShellAttestationInvocation,
  makeAppxPackArguments,
  parseMakeAppxPowerShellAttestation,
  PINNED_WINDOWS_SDK_VERSION,
  readExpectedMsixManifestIdentity,
  resolvePinnedMakeAppxPath,
  type MakeAppxToolEvidence,
} from "../lib/windows-msix.ts";
import {
  assertUniqueWindowsPackagePaths,
  assertOpenDescriptorMatchesStableFile,
  inspectStableFile,
  validateWindowsPackagePath,
} from "../lib/windows-msix-path-policy.ts";
import {
  SYNTHETIC_WINDOWS_SOURCE_COMMIT,
  createSyntheticFinalizedWindowsApplication,
} from "./helpers/windows-finalized-app-fixture.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const msixRoot = join(projectRoot, "desktop", "msix");

function temporaryDirectory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rangabot-msix-test-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Windows package paths reject traversal, ADS, aliases, and casefold collisions", () => {
  for (const unsafe of [
    "../escape.txt", "/absolute", "C:\\absolute", "safe//gap", "safe/./dot",
    "name:stream", "tail. ", "CON", "con.txt", "CONIN$", "conout$.txt",
    "COM1.log", "COM¹.txt", "LPT²",
  ]) {
    assert.throws(() => validateWindowsPackagePath(unsafe), /safe|component/u, unsafe);
  }
  assert.equal(validateWindowsPackagePath("resources\\app.asar"), "resources/app.asar");
  assert.throws(() => assertUniqueWindowsPackagePaths(["Foo.txt", "foo.txt"]), /path collision/u);
  assert.throws(() => assertUniqueWindowsPackagePaths(["caf\u00e9.txt", "cafe\u0301.txt"]), /path collision/u);
  assert.throws(() => validateWindowsPackagePath(`${"a".repeat(130)}/${"b".repeat(130)}`), /260-character/u);
});

test("opened descriptors must bind the exact pre-hashed file identity", () => {
  const root = temporaryDirectory();
  const path = join(root, "candidate.msix");
  const moved = join(root, "original.msix");
  writeFileSync(path, "original");
  const evidence = inspectStableFile(path, { label: "Synthetic stable file" });
  renameSync(path, moved);
  writeFileSync(path, "replacement");
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    assert.throws(
      () => assertOpenDescriptorMatchesStableFile(descriptor, evidence, "Synthetic stable file"),
      /does not match the pre-hashed/u,
    );
  } finally {
    closeSync(descriptor);
  }
});

test("MakeAppx arguments always retain semantic validation", () => {
  const args = makeAppxPackArguments("mapping.txt", "candidate.msix");
  assert.deepEqual(args.slice(0, 1), ["pack"]);
  assert.deepEqual(args.slice(-4), ["/h", "SHA256", "/no", "/v"]);
  assert.equal(args.includes("/nv"), false);
  assert.equal(args.includes("/o"), false);
});

test("pinned MakeAppx discovery accepts only the exact SDK directory", () => {
  const root = temporaryDirectory();
  const tool = join(root, "Windows Kits", "10", "bin", PINNED_WINDOWS_SDK_VERSION, "x64", "MakeAppx.exe");
  mkdirSync(resolve(tool, ".."), { recursive: true });
  writeFileSync(tool, "synthetic tool");
  assert.equal(resolvePinnedMakeAppxPath({ programFilesX86: root }), tool);
  assert.throws(
    () => resolvePinnedMakeAppxPath({ programFilesX86: root, requestedSdkVersion: "10.0.22621.0" }),
    /not the pinned/u,
  );
  assert.deepEqual(assertPinnedWindowsToolRootStrings({
    systemRoot: "c:/WINDOWS/",
    programFilesX86: "C:\\Program Files (x86)\\",
  }), {
    systemRoot: "C:\\Windows",
    programFilesX86: "C:\\Program Files (x86)",
  });
  assert.throws(() => assertPinnedWindowsToolRootStrings({
    systemRoot: "D:\\Windows",
    programFilesX86: "C:\\Program Files (x86)",
  }), /exact protected/u);
});

test("Windows PowerShell 5.1 receives and returns the exact MakeAppx path through stdin", () => {
  const makeAppxPath = "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\MakeAppx.exe";
  const invocation = makeAppxPowerShellAttestationInvocation(makeAppxPath);
  assert.deepEqual(invocation.args.slice(0, 4), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  ]);
  assert.equal(invocation.args.length, 5);
  assert.equal(invocation.args.includes(makeAppxPath), false);
  assert.doesNotMatch(invocation.args[4], /\$args\[0\]/u);
  assert.match(invocation.args[4], /\[Console\]::In\.ReadToEnd\(\)/u);
  assert.match(invocation.args[4], /\$env:PSModulePath=\[IO\.Path\]::Combine\(\$PSHOME,'Modules'\)/u);
  assert.match(invocation.args[4], /\$securityManifest=\[IO\.Path\]::Combine\(\$env:PSModulePath,'Microsoft\.PowerShell\.Security','Microsoft\.PowerShell\.Security\.psd1'\)/u);
  assert.match(invocation.args[4], /\$loadedModule=Import-Module -Name \$securityManifest -Force -PassThru -ErrorAction Stop/u);
  assert.match(invocation.args[4], /\$loadedModule\.Path -ne \$securityManifest/u);
  assert.match(invocation.args[4], /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature/u);
  assert.doesNotMatch(invocation.args[4], /Import-Module Microsoft\.PowerShell\.Security/u);
  assert.doesNotMatch(invocation.args[4], /\$s=Get-AuthenticodeSignature/u);
  const sanitizeIndex = invocation.args[4].indexOf("$env:PSModulePath=");
  const manifestIndex = invocation.args[4].indexOf("$securityManifest=");
  const importIndex = invocation.args[4].indexOf("Import-Module -Name $securityManifest");
  const signatureIndex = invocation.args[4].indexOf("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature");
  assert.ok(sanitizeIndex >= 0 && sanitizeIndex < manifestIndex);
  assert.ok(manifestIndex < importIndex && importIndex < signatureIndex);
  assert.match(invocation.args[4], /attestedPath=\$p/u);
  assert.equal(invocation.input, makeAppxPath);
  assert.throws(
    () => makeAppxPowerShellAttestationInvocation(""),
    /requires one exact filesystem path/u,
  );
});

test("PowerShell MakeAppx attestation rejects path, version, signature, signer, and JSON drift", () => {
  const expectedPath = "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\MakeAppx.exe";
  const expectedModuleHome = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules";
  const expectedModuleManifest = `${expectedModuleHome}\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1`;
  const valid = {
    attestedPath: expectedPath,
    moduleHome: expectedModuleHome,
    moduleManifest: expectedModuleManifest,
    fileVersion: "10.0.26100.3916",
    productVersion: "10.0.26100.3916",
    status: "Valid",
    signerSubject: "CN=Microsoft Windows, O=Microsoft Corporation, C=US",
  };
  assert.deepEqual(parseMakeAppxPowerShellAttestation(
    JSON.stringify(valid), expectedPath, expectedModuleHome, expectedModuleManifest,
  ), valid);
  for (const [label, mutation] of [
    ["empty path", { attestedPath: "" }],
    ["mismatched path", { attestedPath: `${expectedPath}.other` }],
    ["wrong module home", { moduleHome: "C:\\Program Files\\PowerShell\\7\\Modules" }],
    ["wrong module manifest", { moduleManifest: "C:\\Program Files\\PowerShell\\7\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" }],
    ["wrong file version", { fileVersion: "10.0.22621.1" }],
    ["wrong product version", { productVersion: "10.0.22621.1" }],
    ["invalid signature", { status: "HashMismatch" }],
    ["wrong signer", { signerSubject: "CN=Other, O=Other Corporation, C=US" }],
  ] as const) {
    assert.throws(
      () => parseMakeAppxPowerShellAttestation(
        JSON.stringify({ ...valid, ...mutation }), expectedPath, expectedModuleHome, expectedModuleManifest,
      ),
      /expected path, version, and valid Microsoft signature/u,
      label,
    );
  }
  assert.throws(
    () => parseMakeAppxPowerShellAttestation("{", expectedPath, expectedModuleHome, expectedModuleManifest),
    SyntaxError,
  );
});

test("Windows CI exercises the protected PowerShell 5.1 MakeAppx attestor", {
  skip: process.platform !== "win32",
}, () => {
  const evidence = inspectPinnedMakeAppx();
  assert.equal(evidence.sdkVersion, PINNED_WINDOWS_SDK_VERSION);
  assert.equal(evidence.path, resolve(
    "C:\\Program Files (x86)", "Windows Kits", "10", "bin",
    PINNED_WINDOWS_SDK_VERSION, "x64", "MakeAppx.exe",
  ));
  assert.match(evidence.fileVersion, /^10\.0\.26100\./u);
  assert.match(evidence.productVersion, /^10\.0\.26100\./u);
  assert.equal(evidence.authenticodeStatus, "Valid");
  assert.match(evidence.signerSubject, /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/u);
  assert.equal(evidence.attestor.relativePath, "System32/WindowsPowerShell/v1.0/powershell.exe");
});

test("approved manifest has the exact single-app full-trust identity", () => {
  const path = join(msixRoot, "AppxManifest.xml");
  const evidence = inspectStableFile(path, { label: "Test MSIX manifest" });
  assert.equal(evidence.sha256, APPROVED_MSIX_MANIFEST_SHA256);
  assert.deepEqual(readExpectedMsixManifestIdentity(path), {
    name: "RangaBot.InternalCandidate",
    publisher: "CN=RangaBot Internal Candidate, OID.2.25.311729368913984317654407730594956997722=1",
    version: "0.1.0.0",
    architecture: "x64",
    applicationId: "RangaBotInternalCandidate",
    executable: "RangaBot.exe",
    entryPoint: "Windows.FullTrustApplication",
    capabilities: ["runFullTrust"],
  });
});

test("source inventory includes exact manifest, brand assets, app, and desktop identity", () => {
  const root = temporaryDirectory();
  const app = join(root, "RangaBot-win32-x64");
  mkdirSync(join(app, "resources", "rangabot-resources", "desktop"), { recursive: true });
  writeFileSync(join(app, "RangaBot.exe"), "synthetic PE fixture");
  writeFileSync(join(app, "resources", "app.asar"), "synthetic asar fixture");
  mkdirSync(join(app, "resources", "rangabot-resources", ".next", "server", "app", "api", "profiles", "[id]"), { recursive: true });
  writeFileSync(join(app, "resources", "rangabot-resources", ".next", "server", "app", "api", "profiles", "[id]", "route.js"), "compiled route");
  writeFileSync(join(app, "resources", "rangabot-resources", "desktop", "manifest.json"), "{}\n");
  const inventory = collectMsixSourceInventory({
    applicationRoot: app,
    manifestPath: join(msixRoot, "AppxManifest.xml"),
    assetsRoot: join(msixRoot, "assets"),
  });
  assert.deepEqual(inventory.map((entry) => entry.packagePath), [
    "AppxManifest.xml",
    "Assets/Square150x150Logo.png",
    "Assets/Square44x44Logo.png",
    "Assets/StoreLogo.png",
    "RangaBot.exe",
    "resources/app.asar",
    "resources/rangabot-resources/.next/server/app/api/profiles/[id]/route.js",
    "resources/rangabot-resources/desktop/manifest.json",
  ]);
  const mapping = createMakeAppxMapping(inventory);
  assert.match(mapping, /^\[Files\]\r\n/u);
  assert.match(mapping, /"AppxManifest\.xml"/u);
  assert.doesNotMatch(mapping, /\/nv/u);
});

test("source inventory rejects actual model weights and private runtime data", () => {
  for (const forbidden of [
    ".ollama/models/blobs/sha256-fixture",
    "weights/model.gguf",
    "resources/rangabot-resources/data/profiles/default.json",
    "resources/rangabot-resources/rangabot-memory.db",
  ]) {
    const root = temporaryDirectory();
    const app = join(root, "app");
    mkdirSync(join(app, "resources", "rangabot-resources", "desktop"), { recursive: true });
    writeFileSync(join(app, "RangaBot.exe"), "synthetic PE fixture");
    writeFileSync(join(app, "resources", "rangabot-resources", "desktop", "manifest.json"), "{}\n");
    const path = join(app, ...forbidden.split("/"));
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "private fixture");
    assert.throws(() => collectMsixSourceInventory({
      applicationRoot: app,
      manifestPath: join(msixRoot, "AppxManifest.xml"),
      assetsRoot: join(msixRoot, "assets"),
    }), /private data|model weight|private-payload/u, forbidden);
  }
});

function syntheticMakeAppx(toolPath: string): MakeAppxToolEvidence {
  writeFileSync(toolPath, "synthetic MakeAppx fixture");
  const toolFile = inspectStableFile(toolPath, { label: "Synthetic MakeAppx fixture" });
  return Object.freeze({
    path: toolPath,
    sdkVersion: PINNED_WINDOWS_SDK_VERSION,
    bytes: toolFile.bytes,
    sha256: toolFile.sha256,
    fileVersion: "10.0.26100.1",
    productVersion: "10.0.26100.1",
    authenticodeStatus: "Valid",
    signerSubject: "CN=Microsoft Windows, O=Microsoft Corporation, C=US",
    attestor: Object.freeze({
      relativePath: "System32/WindowsPowerShell/v1.0/powershell.exe",
      bytes: 1,
      sha256: "a".repeat(64),
    }),
    file: toolFile,
  });
}

test("builder invokes exact MakeAppx argv without a shell and leaves signature unverified", () => {
  const root = temporaryDirectory();
  const application = createSyntheticFinalizedWindowsApplication(join(root, "inputs"));
  const app = application.appRoot;
  const output = join(root, "outputs", "candidate.msix");
  const mapping = join(root, "outputs", "mapping.txt");
  const toolPath = join(root, "tool", "MakeAppx.exe");
  mkdirSync(resolve(toolPath, ".."), { recursive: true });
  const makeAppx = syntheticMakeAppx(toolPath);
  let invocation: { file: string; args: readonly string[]; options: unknown } | undefined;
  const built = buildUnsignedMsix({
    applicationRoot: app,
    manifestPath: join(msixRoot, "AppxManifest.xml"),
    assetsRoot: join(msixRoot, "assets"),
    generatedRoot: root,
    checkedOutCommit: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
    expectedSourceSha: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
    mappingPath: mapping,
    outputPath: output,
    makeAppx,
    run(file, args, options) {
      invocation = { file, args: [...args], options };
      writeFileSync(output, "synthetic unsigned MSIX fixture");
    },
  });
  assert.equal(invocation?.file, toolPath);
  assert.deepEqual(invocation?.args, [
    "pack", "/f", mapping, "/p", output, "/h", "SHA256", "/no", "/v",
  ]);
  assert.deepEqual(invocation?.options, { stdio: "inherit", windowsHide: true });
  assert.equal(built.packageSignature, "unverified");
  assert.equal(built.distributionTrust, "unsigned-candidate");
});

test("builder rejects mapping or package output inside immutable inputs", () => {
  const root = temporaryDirectory();
  const app = join(root, "app");
  const toolDirectory = join(root, "tool");
  mkdirSync(join(app, "resources", "rangabot-resources", "desktop"), { recursive: true });
  mkdirSync(toolDirectory, { recursive: true });
  writeFileSync(join(app, "RangaBot.exe"), "synthetic PE fixture");
  writeFileSync(join(app, "resources", "rangabot-resources", "desktop", "manifest.json"), "{}\n");
  const makeAppx = syntheticMakeAppx(join(toolDirectory, "MakeAppx.exe"));
  assert.throws(() => buildUnsignedMsix({
    applicationRoot: app,
    manifestPath: join(msixRoot, "AppxManifest.xml"),
    assetsRoot: join(msixRoot, "assets"),
    generatedRoot: root,
    checkedOutCommit: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
    expectedSourceSha: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
    mappingPath: join(app, "mapping.txt"),
    outputPath: join(root, "candidate.msix"),
    makeAppx,
    run() { throw new Error("must not run"); },
  }), /cannot be written inside/u);
});

test("builder fails closed if a source is added, deleted, or mutated during MakeAppx", () => {
  for (const action of ["added", "deleted", "mutated"] as const) {
    const root = temporaryDirectory();
    const app = createSyntheticFinalizedWindowsApplication(join(root, "inputs")).appRoot;
    const outputs = join(root, "outputs");
    const toolDirectory = join(root, "tool");
    mkdirSync(toolDirectory, { recursive: true });
    const makeAppx = syntheticMakeAppx(join(toolDirectory, "MakeAppx.exe"));
    assert.throws(() => buildUnsignedMsix({
      applicationRoot: app,
      manifestPath: join(msixRoot, "AppxManifest.xml"),
      assetsRoot: join(msixRoot, "assets"),
      generatedRoot: root,
      checkedOutCommit: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
      expectedSourceSha: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
      mappingPath: join(outputs, "mapping.txt"),
      outputPath: join(outputs, "candidate.msix"),
      makeAppx,
      run(_file, _args, _options) {
        writeFileSync(join(outputs, "candidate.msix"), "synthetic package");
        if (action === "added") writeFileSync(join(app, "late-file.txt"), "late");
        else if (action === "deleted") rmSync(join(app, "RangaBot.exe"));
        else appendFileSync(join(app, "RangaBot.exe"), "changed");
      },
    }), /changed/u, action);
  }
});

test("builder rejects stale, dangling-linked, and raced output destinations", () => {
  for (const state of ["stale", "dangling", "race"] as const) {
    const root = temporaryDirectory();
    const app = createSyntheticFinalizedWindowsApplication(join(root, "inputs")).appRoot;
    const outputs = join(root, "outputs");
    const output = join(outputs, "candidate.msix");
    const toolDirectory = join(root, "tool");
    mkdirSync(outputs, { recursive: true });
    mkdirSync(toolDirectory, { recursive: true });
    const makeAppx = syntheticMakeAppx(join(toolDirectory, "MakeAppx.exe"));
    if (state === "stale") writeFileSync(output, "stale");
    if (state === "dangling") symlinkSync(join(root, "missing-target"), output);
    assert.throws(() => buildUnsignedMsix({
      applicationRoot: app,
      manifestPath: join(msixRoot, "AppxManifest.xml"),
      assetsRoot: join(msixRoot, "assets"),
      generatedRoot: root,
      checkedOutCommit: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
      expectedSourceSha: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
      mappingPath: join(outputs, "mapping.txt"),
      outputPath: output,
      makeAppx,
      run() {
        if (state !== "race") throw new Error("must not run");
        symlinkSync(join(root, "missing-race-target"), output);
      },
    }), /lexically absent|non-linked/u, state);
  }
});

test("builder rejects a linked generated-output ancestor before writing", () => {
  const root = temporaryDirectory();
  const app = join(root, "inputs", "app");
  const redirectTarget = join(root, "redirect-target");
  const linkedParent = join(root, "linked-parent");
  const toolDirectory = join(root, "tool");
  mkdirSync(join(app, "resources", "rangabot-resources", "desktop"), { recursive: true });
  mkdirSync(redirectTarget, { recursive: true });
  mkdirSync(toolDirectory, { recursive: true });
  symlinkSync(redirectTarget, linkedParent);
  writeFileSync(join(app, "RangaBot.exe"), "synthetic PE fixture");
  writeFileSync(join(app, "resources", "rangabot-resources", "desktop", "manifest.json"), "{}\n");
  const makeAppx = syntheticMakeAppx(join(toolDirectory, "MakeAppx.exe"));
  assert.throws(() => buildUnsignedMsix({
    applicationRoot: app,
    manifestPath: join(msixRoot, "AppxManifest.xml"),
    assetsRoot: join(msixRoot, "assets"),
    generatedRoot: root,
    checkedOutCommit: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
    expectedSourceSha: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
    mappingPath: join(linkedParent, "mapping.txt"),
    outputPath: join(linkedParent, "candidate.msix"),
    makeAppx,
    run() { throw new Error("must not run"); },
  }), /linked or non-directory/u);
});
