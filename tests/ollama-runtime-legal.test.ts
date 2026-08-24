import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OLLAMA_ARM64_RETAINED_RUNTIME_FILES,
  OLLAMA_RUNTIME_GO_MODULE_COUNT,
  OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256,
  OLLAMA_RUNTIME_GO_LICENSE_BYTES,
  OLLAMA_RUNTIME_GO_LICENSE_FILE_COUNT,
  OLLAMA_RUNTIME_GO_LICENSE_INVENTORY_SHA256,
  OLLAMA_RUNTIME_NOTICE_BYTES,
  OLLAMA_RUNTIME_NOTICE_SHA256,
  OLLAMA_RUNTIME_SOURCE_COMMIT,
  auditOllamaArm64RuntimePayload,
  inspectOllamaRuntimeLegalNotice,
  parseOllamaGoBuildInfo,
  validateOllamaArm64RuntimeFileIdentities,
} from "../lib/ollama-runtime-legal.ts";

const noticePath = "desktop/legal/OLLAMA_RUNTIME_NOTICES.md";
const gitAttributesPath = ".gitattributes";

function reviewedGoModules() {
  const notice = readFileSync(noticePath, "utf8");
  const table = notice.slice(
    notice.indexOf("## Compiled Go module inventory"),
    notice.indexOf("## Native and toolchain source inventory"),
  );
  const modules: Array<{ path: string; version: string; sum: string }> = [];
  for (const line of table.split("\n")) {
    const match = line.match(/^\| ([^|]+) \| ([^|]+) \| `([^`]+)` \|/u);
    if (match && match[1] !== "Module" && !match[1].startsWith("---")) {
      modules.push({ path: match[1].trim(), version: match[2].trim(), sum: match[3] });
    }
  }
  assert.equal(modules.length, OLLAMA_RUNTIME_GO_MODULE_COUNT);
  return modules;
}

function unsignedVarint(value: number) {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function syntheticOllamaBuildInfo(options: {
  architecture?: string;
  dependencies?: readonly { path: string; version: string; sum: string }[];
  mainVersion?: string;
  sourceCommit?: string;
} = {}) {
  const dependencies = options.dependencies ?? reviewedGoModules();
  const moduleText = Buffer.from([
    "path\tgithub.com/ollama/ollama",
    `mod\tgithub.com/ollama/ollama\t${options.mainVersion ?? "v0.32.9+dirty"}\th1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
    ...dependencies.map((entry) => `dep\t${entry.path}\t${entry.version}\t${entry.sum}`),
    "build\tGOOS=darwin",
    `build\tGOARCH=${options.architecture ?? "arm64"}`,
    "build\tvcs=git",
    `build\tvcs.revision=${options.sourceCommit ?? OLLAMA_RUNTIME_SOURCE_COMMIT}`,
    "build\tvcs.modified=true",
    "",
  ].join("\n"), "utf8");
  const goVersion = Buffer.from("go1.26.0", "utf8");
  return Buffer.concat([
    Buffer.from([0xff, ...Buffer.from(" Go buildinf:", "ascii"), 8, 2, ...Buffer.alloc(16)]),
    unsignedVarint(goVersion.length),
    goVersion,
    unsignedVarint(moduleText.length),
    moduleText,
    Buffer.alloc(64),
  ]);
}

test("reviewed Ollama arm64 notice is exact and maps every retained runtime path and hash", () => {
  const inspected = inspectOllamaRuntimeLegalNotice(noticePath);
  assert.deepEqual(inspected, {
    bytes: OLLAMA_RUNTIME_NOTICE_BYTES,
    sha256: OLLAMA_RUNTIME_NOTICE_SHA256,
  });
  assert.match(
    readFileSync(gitAttributesPath, "utf8"),
    /^desktop\/legal\/OLLAMA_RUNTIME_NOTICES\.md -text whitespace=-trailing-space$/mu,
    "Git must preserve the reviewed aggregate notice without line-ending or whitespace rewrites",
  );
  const notice = readFileSync(noticePath, "utf8");
  assert.equal(Buffer.byteLength(notice), OLLAMA_RUNTIME_NOTICE_BYTES);
  assert.match(notice, new RegExp(`Compiled Go modules: ${OLLAMA_RUNTIME_GO_MODULE_COUNT}`));
  assert.match(notice, new RegExp(OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256));
  assert.match(notice, new RegExp(`Recursive license-like files from exact h1-verified module zips: ${OLLAMA_RUNTIME_GO_LICENSE_FILE_COUNT}`));
  assert.match(notice, new RegExp(`Recursive module-license bytes: ${OLLAMA_RUNTIME_GO_LICENSE_BYTES}`));
  assert.match(notice, new RegExp(OLLAMA_RUNTIME_GO_LICENSE_INVENTORY_SHA256));
  assert.match(notice, new RegExp(OLLAMA_RUNTIME_SOURCE_COMMIT));
  assert.equal(OLLAMA_ARM64_RETAINED_RUNTIME_FILES.length, 10);
  assert.equal(new Set(OLLAMA_ARM64_RETAINED_RUNTIME_FILES.map((entry) => entry.path)).size, 10);
  for (const entry of OLLAMA_ARM64_RETAINED_RUNTIME_FILES) {
    assert.ok(notice.includes(`| \`${entry.path}\` | \`${entry.sha256}\` |`));
  }
  for (const requiredNativeNotice of [
    "llamafile sgemm",
    "miniaudio 0.11.25",
    "stb_image",
    "metal-cpp",
    "MLX-C",
    "cpp-httplib",
    "nlohmann/json@v3.11.3",
    "Unicode Character Database@15.1.0",
    "YaRN@995db5b575e75230b3384d658f8b944c9662f775",
    "Pillow Resample@807d689a83738027b6f6e0f219a6a6dd30e01c08",
    "cmp-nct ggllm@0dc65eb735f90f82143ead9dedb66e73fa25d114",
    "Arm optimized-routines@67126040cf80f956676fbf473c2d9bebdb475283",
    "whisper.cpp adapted code",
    "MLX PocketFFT@8c28c385f86d17e1da427bf8d81afe084ee17c35",
    "MLX small_vector V8 adaptation@8c28c385f86d17e1da427bf8d81afe084ee17c35",
    "MLX expm1f Norbert Juffa adaptation@8c28c385f86d17e1da427bf8d81afe084ee17c35",
    "MLX cexpf NVIDIA and Filipe adaptation@8c28c385f86d17e1da427bf8d81afe084ee17c35",
    "supervised-lda@fe3a39bb0d6c7d0c2a33f069440869ad70774da8",
    "nlohmann/json Abseil adaptation@v3.12.0",
    "nlohmann/json Hedley attribution@v3.12.0",
    "nlohmann/json Florian Loitsch adaptation@v3.12.0",
    "nlohmann/json Bjoern Hoehrmann adaptation@v3.12.0",
    "agnivade levenshtein Gist provenance@v1.1.1",
    "Andrei Mackenzie Levenshtein Gist MIT notice@raw revision 67a5e3613c0072d124035ee8933a23de2105cfe3",
    "kigiri Levenshtein Gist MIT comment@comment 1931258",
    "Apache Arrow ORC adaptation@bc219186db40",
    "Charmbracelet ANSI tmux port@38fb69db254fb15a39427143e76768fe176e8b9b",
    "tmux colour.c ISC notice@3.5a",
    "math32 FreeBSD Sun log notice@7caa3bba2ee1e00c12d7a319f964dc7dcb4adc03",
    "math32 FreeBSD pow provenance@7caa3bba2ee1e00c12d7a319f964dc7dcb4adc03",
    "math32 Cephes tanh attribution@7caa3bba2ee1e00c12d7a319f964dc7dcb4adc03",
    "klauspost compress FSE Yann Collet attribution@1d6cf28a9eac67b569bb334c04e1dcb8bf02cf17",
    "klauspost compress Zstd Yann Collet attribution@1d6cf28a9eac67b569bb334c04e1dcb8bf02cf17",
    "pdevine tensor NumPy RollAxis adaptation@f88f4562727c20425d4b6cad576a4401aa4caa63",
    "pdevine tensor NumPy Norm adaptation@f88f4562727c20425d4b6cad576a4401aa4caa63",
    "Gonum Probab BSD notice@c72bc440ad773810d5787c662f2b67a5e0ded3e4",
    "Gonum AMOS SLATEC public-domain provenance@c72bc440ad773810d5787c662f2b67a5e0ded3e4",
    "Gonum AMOS Netlib attribution@c72bc440ad773810d5787c662f2b67a5e0ded3e4",
    "mimetype Go JSON adaptation@e64d6bdb3607578757d31380818651a9fc95ca8b",
    "Gin httprouter path attribution@75ccf94d605a05fe24817fc2f166f6f2959d5cea",
    "YAML mgo BSON provenance@v3.0.1",
    "NumPy@v1.9.1",
    "Finite State Entropy@9f30e0918f87bd835fa040d922a208d7b219e50b",
    "httprouter@v1.3.0",
    "mgo@9856a29383ce1c59f308dd1cf0363a79b5bef6b5",
    "Cephes@Netlib content SHA-256 82004ae6ed8feb08fd16783b6b32e82adfe047f60cb2f238dbf5d4bf9dae42a2",
  ]) assert.match(notice, new RegExp(requiredNativeNotice.replace("/", "\\/"), "u"));
  for (const requiredProvenanceSha256 of [
    "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96",
    "2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86",
    "0d2da782ead4e85630d510f50808355e8c3355e670841d257dd1e6fbd40db9fa",
    "95170cd1c105a5b41a1b2dce73b0fae8ce8011ef7897600828bb2babe8b26e5d",
    "c3ec00ded224ebaaa673373961babc2d79f3081914897f3325cb7927a76234c1",
    "15181e7363dca9aed78b79bebebc7fde7f1814b8bd311ea3b87ae8ccadfc185b",
    "03871befb92d000a22dd5d5fe89381afe4ae461a219d2d4f79912dfdb5e56a23",
    "650afbf29f214451e02241adc42534e82c9d6ae2b38e2444b92b5a1ffcaf9346",
    "46810eb31419fe6f675d585633b08b871175ef50bfe6d54e808bc7d98277d565",
    "d8dba7bc68146aed8a0bb243b04bde9b9742ae4517b7b8b4e18d02568d1d2c8d",
    "7d0eccfbd1392776c1567465df15650da73875e2d1a9324443e69c0041d0dea2",
    "a3c623628c93def5dba670acf443e2215ce61853aff90687ab57c4236f52fed4",
    "b50379222802591434ac7a2137ba171b6c7529e9c1bb95eba1c9c9aa55609621",
    "074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff",
    "f566a9f97bacdaf00d9f21dd991e81dc11201c4e016c86b470799429a1c9a79c",
    "f5b6a58f5d2082e403c49663d87566328d40cf03f16abb01f52632a09b97c55e",
    "5a91226ddfd61461d8dd6bca70ce98e1037af9db5ffa1f8357bcf71f28eb727f",
    "c676df0814357087a875943355095d0eaf24e28c4ef6c0523a2c2c1b23712f66",
    "162ce11ad71338d0a0c6ebaf5c48af72c6ae237b468859d3656fe2d9ed3f3a85",
    "fe60e0cc90e88f12c814adb7dc88df6791c6ec6798d8c856b7d5ad1b805b4f10",
    "82004ae6ed8feb08fd16783b6b32e82adfe047f60cb2f238dbf5d4bf9dae42a2",
    "a25d25acfeb75944fc0f3e8469c78ed1b62bb95815200c4e7974b3493e65674e",
    "104a08914a28490dfe8726a7a075206aba26d78cc4c2e869727f9e9dbecb1c08",
    "e73c8b64bc90c157928992b0c1662cc304ebd96ed3312f21313a92e7cb59b484",
    "b7580cb480527abc7aed9fb6fe42baf3c112317c7cfb0df07c6adfcd501f8ea8",
    "be29456516919e998b8d11b3a6b01265aa1c50b2f97a5e4b2091bb7219291ec7",
    "d1f606e01cfbc5ed1afee28d9c28774b8aeba301331bf2ceda0bbc0c9598377d",
    "d9668bb90d9f895a4f9937a90fcd677a16223df5d95fe9a5c204ddf15b519e0a",
    "f1f605fac83db7cae968994f04b08b909457ee11724d260bb8e59d69c4af27cd",
    "c9ae62be4de7c5a8a8a30621e9f51e55c17fdfb78db40ebf3c35f9058118c4f7",
    "f121af15c0bba1748acd9080223b2199b0bdca8f1c63716204da0f3a0b53e902",
    "ae620bcfde8d98890cefd7aa39934b11b8c31f2ac3a02b4227bb8ecd149c92cd",
    "caaf359283e2dc055ed7a6825080d7327167091562d7cfe53a05351331afa79f",
    "74302ff6955813092d3fee1a8587a30c258339bff3cc762f3b521805e4318022",
    "0710a4f0ab9fb1231fe1c5b8e646a441db7683958919aabf2d13c360640e52d9",
    "919b7b4a3191a1ba7c9de17f3d4176753c0a59c8abd030925172bda8cebe6ea7",
    "ca000d61e7605652f4e1acc64fd387f0a2a8adc684cf0ba85867704f20f27859",
    "1a7e7106abc8257963c4fc24b280ad4faf119b41d5ae92fb56377f8381c3f13d",
    "b07e10a801b961bae3af710aa7b6e6bee7916b95722c1037429174861f3ba901",
    "0ff2536eeff2717b3b859a4c175798ec37faa69cc0e4a33b53c85faa6b9da1c4",
  ]) assert.match(notice, new RegExp(requiredProvenanceSha256, "u"));
});

test("Ollama runtime notice inspection rejects changed bytes and symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-ollama-legal-"));
  try {
    const changed = join(root, "changed.md");
    writeFileSync(changed, `${readFileSync(noticePath, "utf8")}changed\n`);
    assert.throws(() => inspectOllamaRuntimeLegalNotice(changed), /exact reviewed real file|reviewed SHA-256/u);
    const linked = join(root, "linked.md");
    symlinkSync(join(process.cwd(), noticePath), linked);
    assert.throws(() => inspectOllamaRuntimeLegalNotice(linked), /exact reviewed real file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ollama arm64 runtime inventory rejects missing, extra, renamed, changed, or empty files", () => {
  const exact = OLLAMA_ARM64_RETAINED_RUNTIME_FILES.map((entry) => ({ ...entry, bytes: 1 }));
  assert.equal(validateOllamaArm64RuntimeFileIdentities(exact).length, 10);
  const adversaries = [
    exact.slice(1),
    [...exact, { path: "unexpected", bytes: 1, sha256: "00".repeat(32) }],
    exact.map((entry, index) => index === 0 ? { ...entry, path: "renamed" } : entry),
    exact.map((entry, index) => index === 0 ? { ...entry, sha256: "00".repeat(32) } : entry),
    exact.map((entry, index) => index === 0 ? { ...entry, bytes: 0 } : entry),
  ];
  for (const adversary of adversaries) {
    assert.throws(() => validateOllamaArm64RuntimeFileIdentities(adversary), /exact ten|file changed/u);
  }
});

test("Ollama Go build-info parser rejects altered dependency, version, sum, revision, arch, or count", () => {
  const exactModules = reviewedGoModules();
  const exact = parseOllamaGoBuildInfo(syntheticOllamaBuildInfo());
  assert.equal(exact.length, 1);
  assert.equal(exact[0].architecture, "arm64");
  assert.equal(exact[0].dependencies.length, OLLAMA_RUNTIME_GO_MODULE_COUNT);
  const changedVersion = exactModules.map((entry, index) => index === 0 ? { ...entry, version: "v9.9.9" } : entry);
  const changedSum = exactModules.map((entry, index) => index === 0
    ? { ...entry, sum: `h1:A${entry.sum.slice(4)}` }
    : entry);
  for (const binary of [
    syntheticOllamaBuildInfo({ dependencies: changedVersion }),
    syntheticOllamaBuildInfo({ dependencies: changedSum }),
    syntheticOllamaBuildInfo({ dependencies: exactModules.slice(1) }),
    syntheticOllamaBuildInfo({ mainVersion: "v0.32.8+dirty" }),
    syntheticOllamaBuildInfo({ sourceCommit: "0".repeat(40) }),
    syntheticOllamaBuildInfo({ architecture: "x64" }),
  ]) assert.throws(() => parseOllamaGoBuildInfo(binary), /invalid dependency|does not match/u);
});

test("exact real staged Ollama arm64 runtime passes when the focused gate supplies it", (context) => {
  const runtimeRoot = process.env.RANGABOT_TEST_REVIEWED_OLLAMA_RUNTIME_ROOT;
  if (!runtimeRoot) {
    context.skip("set RANGABOT_TEST_REVIEWED_OLLAMA_RUNTIME_ROOT for the pinned archive gate");
    return;
  }
  const audited = auditOllamaArm64RuntimePayload(runtimeRoot);
  assert.equal(audited.files.length, 10);
  assert.equal(audited.executable.compiledGoModules, OLLAMA_RUNTIME_GO_MODULE_COUNT);
  assert.equal(audited.executable.sourceCommit, OLLAMA_RUNTIME_SOURCE_COMMIT);
});

test("desktop release wiring audits before identity and keeps the mac arm64 notice target-specific", () => {
  const prepare = readFileSync("scripts/prepare-desktop.ts", "utf8");
  const finalizer = readFileSync("scripts/finalize-desktop-package.ts", "utf8");
  const verifier = readFileSync("scripts/verify-macos-mas-pkg.ts", "utf8");
  const auditIndex = prepare.indexOf("auditOllamaArm64RuntimePayload(resolve(resourceRoot, \"runtime\", \"ollama\"))");
  const materializeIndex = prepare.indexOf("materializeSafeStagedSymlinks(resourceRoot, resourceRoot)");
  const legalIndex = prepare.indexOf("stageDesktopLegalPayload(resourceRoot, target, !verification)");
  const inventoryIndex = prepare.indexOf("collectDesktopArtifactFiles(resourceRoot)", legalIndex);
  assert.ok(auditIndex >= 0 && materializeIndex > auditIndex && legalIndex > materializeIndex && inventoryIndex > legalIndex);
  assert.match(prepare, /includeManagedRuntime && target\.platform === "darwin"/u);
  assert.match(prepare, /target\.arch !== "arm64"/u);
  assert.match(prepare, /desktop", "legal", "OLLAMA_RUNTIME_NOTICES\.md"/u);
  assert.match(finalizer, /rangabot-resources\/OLLAMA_RUNTIME_NOTICES\.md/u);
  assert.match(finalizer, /inspectOllamaRuntimeLegalNotice/u);
  const copiedResourceReconciliationIndex = finalizer.indexOf("reconcileCopiedDesktopResources(staged.resources, confirmedUnsignedResources)");
  const finalizerRuntimeAuditIndex = finalizer.indexOf("auditOllamaArm64RuntimePayload(join(runtimeResourceRoot, \"runtime\", \"ollama\"))");
  const finalizerSigningIndex = finalizer.indexOf("signEntireAppForMacAppStore(appPath, stagedSignatureMode)");
  assert.ok(copiedResourceReconciliationIndex >= 0
    && finalizerRuntimeAuditIndex > copiedResourceReconciliationIndex
    && finalizerSigningIndex > finalizerRuntimeAuditIndex);
  assert.match(verifier, /"OLLAMA_RUNTIME_NOTICES\.md"/u);
  assert.match(verifier, /reviewedUnsignedRuntimeFiles/u);
  assert.match(verifier, /finalSignedRuntimeFiles: packagedRuntimeFiles/u);
  assert.match(verifier, /auditOllamaRuntimeExecutable/u);
  assert.match(verifier, /finalRuntimeBytesBoundBy: "desktop artifact resource manifest and complete code-signature inventory"/u);
});
