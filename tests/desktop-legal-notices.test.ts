import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createDesktopDependencyNotice } from "../lib/desktop-legal-notices.ts";

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "rangabot-legal-project-"));
  const resourceRoot = join(projectRoot, "staged");
  const sourcePackage = join(projectRoot, "node_modules", "synthetic-dependency");
  const stagedPackage = join(resourceRoot, "node_modules", "synthetic-dependency");
  mkdirSync(sourcePackage, { recursive: true });
  mkdirSync(stagedPackage, { recursive: true });
  const manifest = `${JSON.stringify({ name: "synthetic-dependency", version: "1.2.3", license: "MIT" }, null, 2)}\n`;
  writeFileSync(join(sourcePackage, "package.json"), manifest);
  writeFileSync(join(stagedPackage, "package.json"), manifest);
  writeFileSync(join(sourcePackage, "LICENSE"), "Synthetic dependency license.\n");
  writeFileSync(join(projectRoot, "package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/synthetic-dependency": { version: "1.2.3", license: "MIT" },
    },
  }, null, 2)}\n`);
  return { projectRoot, resourceRoot, sourcePackage, stagedPackage };
}

test("dependency notice is deterministic and binds payload manifests to lock owners and license text", () => {
  const value = fixture();
  try {
    const first = createDesktopDependencyNotice(value);
    const second = createDesktopDependencyNotice(value);
    assert.equal(first.notice, second.notice);
    assert.equal(first.noticeSha256, second.noticeSha256);
    assert.equal(first.dependencies.length, 1);
    assert.equal(first.dependencies[0].lockOwnerVersion, "1.2.3");
    assert.equal(first.dependencies[0].noticeFiles.length, 1);
    assert.match(first.notice, /Package-lock SHA-256/u);
    assert.match(first.notice, /Synthetic dependency license\./u);
    assert.match(first.notice, /Do not edit this generated file by hand/u);
  } finally {
    rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("dependency notice fails closed on a payload mismatch or missing legal declaration", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.stagedPackage, "package.json"), `${JSON.stringify({
      name: "synthetic-dependency",
      version: "9.9.9",
      license: "MIT",
    })}\n`);
    assert.throws(() => createDesktopDependencyNotice(value), /does not match its locked installed manifest/u);
    const source = `${JSON.stringify({ name: "synthetic-dependency", version: "1.2.3" })}\n`;
    writeFileSync(join(value.sourcePackage, "package.json"), source);
    writeFileSync(join(value.stagedPackage, "package.json"), source);
    rmSync(join(value.sourcePackage, "LICENSE"));
    assert.throws(() => createDesktopDependencyNotice(value), /lock owner has no distributable license or notice text/u);
  } finally {
    rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("a nested packaged manifest binds to its exact installed manifest and adjacent legal text", () => {
  const value = fixture();
  try {
    const nestedManifest = `${JSON.stringify({
      name: "synthetic-dependency-plugin",
      version: "1.0.0",
      license: "MIT",
    }, null, 2)}\n`;
    mkdirSync(join(value.sourcePackage, "plugin"));
    mkdirSync(join(value.stagedPackage, "plugin"));
    writeFileSync(join(value.sourcePackage, "plugin", "package.json"), nestedManifest);
    writeFileSync(join(value.stagedPackage, "plugin", "package.json"), nestedManifest);
    writeFileSync(join(value.sourcePackage, "plugin", "LICENSE"), "Synthetic nested dependency license.\n");
    const audit = createDesktopDependencyNotice(value);
    const nested = audit.dependencies.find((entry) => entry.name === "synthetic-dependency-plugin");
    assert.ok(nested);
    assert.equal(nested.lockOwnerPath, "node_modules/synthetic-dependency");
    assert.deepEqual(nested.noticeFiles.map((entry) => entry.name), ["LICENSE"]);
    assert.deepEqual(nested.noticeFiles.map((entry) => entry.sourceKind), ["manifest-adjacent"]);
    assert.deepEqual(nested.noticeFiles.map((entry) => entry.sourcePath), [
      "node_modules/synthetic-dependency/plugin/LICENSE",
    ]);
    assert.match(audit.notice, /Synthetic nested dependency license\./u);
    assert.match(audit.notice, /Declared license identifiers are inventory metadata, not substitutes for retained text/u);

    writeFileSync(join(value.stagedPackage, "plugin", "package.json"), `${JSON.stringify({
      name: "synthetic-dependency-plugin",
      version: "1.0.1",
      license: "MIT",
    })}\n`);
    assert.throws(() => createDesktopDependencyNotice(value), /does not match its installed manifest/u);
    writeFileSync(join(value.stagedPackage, "plugin", "package.json"), nestedManifest);
    rmSync(join(value.sourcePackage, "plugin", "LICENSE"));
    assert.throws(
      () => createDesktopDependencyNotice(value),
      /nested dependency has no adjacent or reviewed distributable license text/u,
    );
  } finally {
    rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("packaged Next vendored manifests bind to exact package-specific legal identities", () => {
  const resourceRoot = mkdtempSync(join(tmpdir(), "rangabot-next-legal-stage-"));
  const packagePaths = [
    "node_modules/next/dist/compiled/@edge-runtime/cookies/package.json",
    "node_modules/next/dist/compiled/@edge-runtime/ponyfill/package.json",
    "node_modules/next/dist/compiled/@edge-runtime/primitives/package.json",
    "node_modules/next/dist/compiled/@hapi/accept/package.json",
    "node_modules/next/dist/compiled/string-hash/package.json",
    "node_modules/next/dist/compiled/tar/package.json",
  ];
  try {
    for (const packagePath of packagePaths) {
      const destination = join(resourceRoot, packagePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(packagePath));
    }
    const audit = createDesktopDependencyNotice({ projectRoot: process.cwd(), resourceRoot });
    const byName = new Map(audit.dependencies.map((entry) => [entry.name, entry]));
    const tar = byName.get("tar");
    assert.ok(tar);
    assert.equal(tar.declaredLicense, "BlueOak-1.0.0");
    assert.equal(tar.packagedManifestSha256, "d118552ac665732fb7a1bb0e08dba0ab1d21a0edbc0eb3601a094ef821198f21");
    assert.deepEqual(tar.noticeFiles, [{
      name: "LICENSE",
      sourcePath: "node_modules/next/dist/compiled/tar/LICENSE",
      sourceKind: "manifest-adjacent",
      bytes: 1_552,
      sha256: "8a1af140fdfbf5afd3df27f7e662f989c5b963a300020dfafce42033cae9e004",
    }]);
    const accept = byName.get("@hapi/accept");
    assert.ok(accept);
    assert.equal(accept.declaredLicense, "BSD-3-Clause");
    assert.equal(accept.packagedManifestSha256, "0e264b353f98a5047f47a4af7cd718888f33345d78a8bbea30eaaac585059abc");
    assert.deepEqual(accept.noticeFiles, [{
      name: "LICENSE",
      sourcePath: "node_modules/next/dist/compiled/@hapi/accept/LICENSE",
      sourceKind: "manifest-adjacent",
      bytes: 1_541,
      sha256: "ff96bbd6a7408c166f16dbed7f2c87a8061e5a21289ec8f2d3069f8d3b15fc0a",
    }]);
    for (const name of ["@edge-runtime/cookies", "@edge-runtime/ponyfill", "@edge-runtime/primitives"]) {
      assert.equal(
        byName.get(name)?.noticeFiles.some((entry) => entry.sourcePath === "node_modules/next/dist/compiled/edge-runtime/LICENSE"
          && entry.sourceKind === "reviewed-fallback"
          && entry.sha256 === "e4f76a7a19ef2989dd79339bd3abf8afcf1d6f065e5a10c76c19415ffd727eb3"),
        true,
      );
    }
    const primitives = byName.get("@edge-runtime/primitives");
    assert.ok(primitives);
    assert.deepEqual(
      primitives.noticeFiles.filter((entry) => entry.sourceKind === "manifest-adjacent").map((entry) => entry.name),
      ["fetch.js.LEGAL.txt", "load.js.LEGAL.txt"],
    );
    const stringHash = byName.get("string-hash");
    assert.ok(stringHash);
    assert.equal(stringHash.declaredLicense, "CC0-1.0");
    assert.deepEqual(stringHash.noticeFiles.map((entry) => ({
      sourcePath: entry.sourcePath,
      sourceKind: entry.sourceKind,
      sha256: entry.sha256,
    })), [{
      sourcePath: "node_modules/next/dist/compiled/postcss-preset-env/LICENSE",
      sourceKind: "reviewed-fallback",
      sha256: "597756adcb51f243ef4fb386920377f61d012ace0904364e1a8ee9aaec6afc84",
    }]);
    assert.doesNotMatch(
      tar.noticeFiles.map((entry) => entry.sha256).join("\n"),
      /ee765244e2d59f5234d474f62e0766fa0c8b99af967fdd4c0cb8dcb0c76ea224/u,
    );
  } finally {
    rmSync(resourceRoot, { recursive: true, force: true });
  }
});

test("desktop preparation stages all legal files before resource identity is derived", () => {
  const prepare = readFileSync("scripts/prepare-desktop.ts", "utf8");
  const finalizer = readFileSync("scripts/finalize-desktop-package.ts", "utf8");
  const materializeIndex = prepare.indexOf("materializeSafeStagedSymlinks(resourceRoot, resourceRoot)");
  const legalIndex = prepare.indexOf("stageDesktopLegalPayload(resourceRoot, target, !verification)");
  const inventoryIndex = prepare.indexOf("collectDesktopArtifactFiles(resourceRoot)", legalIndex);
  assert.ok(materializeIndex >= 0 && legalIndex > materializeIndex && inventoryIndex > legalIndex);
  for (const path of [
    "LICENSE",
    "DEPENDENCY_NOTICES.md",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    assert.match(prepare, new RegExp(`resolve\\(resourceRoot, "${path.replaceAll(".", "\\.")}"\\)`));
    assert.match(finalizer, new RegExp(`rangabot-resources/${path.replaceAll(".", "\\.")}`));
  }
  for (const path of ["ELECTRON_LICENSE", "ELECTRON_CHROMIUM_LICENSES.html"]) {
    assert.match(prepare, new RegExp(`destinationName: "${path.replaceAll(".", "\\.")}"`));
    assert.match(finalizer, new RegExp(`rangabot-resources/${path.replaceAll(".", "\\.")}`));
  }
  assert.match(prepare, /resolve\(resourceRoot, entry\.destinationName\)/u);
  assert.match(prepare, /ELECTRON_LEGAL_PAYLOAD\[target\.platform\]\.map/u);
  assert.match(prepare, /5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d/u);
  assert.match(prepare, /4fc0507a046b9ecd0738b2dd64119b5ec8bc29ac0221b63edb693fd5fd497c87/u);
  assert.match(prepare, /20_313_957/u);
  assert.match(prepare, /b911161e6594ec76b872498b423c54406168f2974e0d407a847f7de1e5ff94dd/u);
  const verifier = readFileSync("scripts/verify-macos-mas-pkg.ts", "utf8");
  assert.match(verifier, /"ELECTRON_LICENSE"/u);
  assert.match(verifier, /"ELECTRON_CHROMIUM_LICENSES\.html"/u);
  assert.match(verifier, /"OLLAMA_RUNTIME_NOTICES\.md"/u);
});
