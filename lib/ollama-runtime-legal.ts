import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const OLLAMA_RUNTIME_VERSION = "0.32.9" as const;
export const OLLAMA_RUNTIME_SOURCE_COMMIT = "1d5febee105f00c430e19214b7b7b620cf186f98" as const;
export const OLLAMA_RUNTIME_GO_VERSION = "go1.26.0" as const;
export const OLLAMA_RUNTIME_GO_MODULE_COUNT = 67 as const;
export const OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256 = "b25a7620036d38bdd28f62ea7c88f7f4a4bf4588c3ade67afd8b9ca187159862" as const;
export const OLLAMA_RUNTIME_GO_LICENSE_FILE_COUNT = 93 as const;
export const OLLAMA_RUNTIME_GO_LICENSE_BYTES = 299_184 as const;
export const OLLAMA_RUNTIME_GO_LICENSE_INVENTORY_SHA256 = "8060a65afd7223def982882622fb8f8bf5804eddb8fc548685987455b957f1c5" as const;
export const OLLAMA_RUNTIME_NOTICE_BYTES = 414_965 as const;
export const OLLAMA_RUNTIME_NOTICE_SHA256 = "24a6943efa83f4f08a70dfa1270ef3a088d57a4cb4741fe73a1d70b7576e27d5" as const;
export const OLLAMA_ARM64_RETAINED_RUNTIME_FILES = Object.freeze([
  Object.freeze({ path: "llama-quantize", sha256: "8214c554ea3dc01ead898a21f744c1f41212ff126b0e53b7d43a736666cb1f86" }),
  Object.freeze({ path: "llama-server", sha256: "04f5d6ee5e66b425fdabc10e96d80785fa78928e6bbda246edb95f1db6c079b7" }),
  Object.freeze({ path: "mlx_metal_v3/libmlx.dylib", sha256: "003e11078f0df8c9b100c0107887aeef22187c605cc10f14aa49eaa0072dd113" }),
  Object.freeze({ path: "mlx_metal_v3/libmlxc.dylib", sha256: "6514772893f6144247b95299c44fe78e106fee5c9785f5148c54d6b4e2f3eb5d" }),
  Object.freeze({ path: "mlx_metal_v3/mlx.metallib", sha256: "23c03f35b0f24ed7f06c8488e52b1eeace66a1a8f18149995459df8badad4ede" }),
  Object.freeze({ path: "mlx_metal_v4/libjaccl.dylib", sha256: "8f34ef90576751373f8e2ed7e42d583c830a485fb21ea0c3833759ee32975c7b" }),
  Object.freeze({ path: "mlx_metal_v4/libmlx.dylib", sha256: "2c2fab2ced5fbc74d8fb884308be75c0d3083c0ef558a59f31cb8e5cd657c197" }),
  Object.freeze({ path: "mlx_metal_v4/libmlxc.dylib", sha256: "f0c900e8d088e6ec1d349c0da443d8cc8d4b21c9401d4242a5cf00c82dff735c" }),
  Object.freeze({ path: "mlx_metal_v4/mlx.metallib", sha256: "6127f5445aa400b2c69e7703e39748ad311005c431ddfa9a495f109e51207a95" }),
  Object.freeze({ path: "ollama", sha256: "086469b3a838546b8b27a154cf6e0513c0619490ff2f94fa85335e1aa39691b0" }),
]);

const goBuildInfoMagic = Buffer.from([0xff, ...Buffer.from(" Go buildinf:", "ascii")]);
const modulePathPattern = /^(?:[a-z0-9._~-]+\.)+[a-z0-9._~-]+\/[A-Za-z0-9._~+\/-]+$/u;
const moduleVersionPattern = /^v[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const moduleSumPattern = /^h1:[A-Za-z0-9+/]{43}=$/u;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function readUnsignedVarintString(source: Buffer, offset: number, label: string) {
  let length = BigInt(0);
  let shift = BigInt(0);
  let bytes = 0;
  for (; bytes < 10; bytes += 1) {
    if (offset + bytes >= source.length) throw new Error(`${label} is truncated.`);
    const value = BigInt(source[offset + bytes]);
    length |= (value & BigInt(0x7f)) << shift;
    if (value < BigInt(0x80)) break;
    shift += BigInt(7);
  }
  if (bytes === 10 || length > BigInt(16 * 1024 * 1024)) throw new Error(`${label} has an invalid length.`);
  const start = offset + bytes + 1;
  const end = start + Number(length);
  if (end > source.length) throw new Error(`${label} is truncated.`);
  return Object.freeze({ value: source.subarray(start, end), next: end });
}

export type OllamaGoModule = Readonly<{
  path: string;
  version: string;
  sum: string;
}>;

export type OllamaGoBuildInfo = Readonly<{
  goVersion: string;
  mainPath: "github.com/ollama/ollama";
  mainVersion: `v${typeof OLLAMA_RUNTIME_VERSION}+dirty`;
  architecture: "amd64" | "arm64";
  sourceCommit: typeof OLLAMA_RUNTIME_SOURCE_COMMIT;
  sourceModified: true;
  dependencies: readonly OllamaGoModule[];
  dependencyInventorySha256: typeof OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256;
}>;

export type OllamaRuntimeFileIdentity = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export function validateOllamaArm64RuntimeFileIdentities(
  files: readonly OllamaRuntimeFileIdentity[],
) {
  if (files.length !== OLLAMA_ARM64_RETAINED_RUNTIME_FILES.length) {
    throw new Error("Staged Ollama arm64 runtime does not contain the exact ten reviewed code files.");
  }
  for (let index = 0; index < OLLAMA_ARM64_RETAINED_RUNTIME_FILES.length; index += 1) {
    const actual = files[index];
    const expected = OLLAMA_ARM64_RETAINED_RUNTIME_FILES[index];
    if (actual.path !== expected.path || actual.sha256 !== expected.sha256
      || !Number.isSafeInteger(actual.bytes) || actual.bytes < 1) {
      throw new Error(`Staged Ollama arm64 runtime file changed: ${expected.path}.`);
    }
  }
  return Object.freeze(files.map((entry) => Object.freeze({ ...entry })));
}

export function parseOllamaGoBuildInfo(source: Buffer): readonly OllamaGoBuildInfo[] {
  if (source.length < 64 || source.length > 1024 * 1024 * 1024) {
    throw new Error("Ollama executable has an invalid size.");
  }
  const records: OllamaGoBuildInfo[] = [];
  for (let offset = source.indexOf(goBuildInfoMagic); offset >= 0; offset = source.indexOf(goBuildInfoMagic, offset + 1)) {
    if (source[offset + 14] !== 8 || source[offset + 15] !== 2) {
      throw new Error("Ollama executable uses an unsupported Go build-info format.");
    }
    const versionRecord = readUnsignedVarintString(source, offset + 32, "Ollama Go version");
    const moduleRecord = readUnsignedVarintString(source, versionRecord.next, "Ollama Go module inventory");
    const goVersion = new TextDecoder("utf-8", { fatal: true }).decode(versionRecord.value);
    const moduleStart = moduleRecord.value.indexOf(Buffer.from("path\t", "ascii"));
    if (moduleStart < 0) throw new Error("Ollama Go module inventory has no main package path.");
    const lines = moduleRecord.value.subarray(moduleStart).toString("utf8").split("\n");
    let mainPath: string | null = null;
    let mainModule: string | null = null;
    let mainVersion: string | null = null;
    const dependencies: OllamaGoModule[] = [];
    const settings = new Map<string, string>();
    let reachedBuildSettings = false;
    for (const line of lines) {
      const fields = line.split("\t");
      if (fields[0] === "path" && fields.length === 2 && mainPath === null && dependencies.length === 0) {
        mainPath = fields[1];
      } else if (fields[0] === "mod" && fields.length >= 3 && mainModule === null && dependencies.length === 0) {
        mainModule = fields[1];
        mainVersion = fields[2];
      } else if (fields[0] === "dep" && fields.length >= 4 && !reachedBuildSettings) {
        if (!modulePathPattern.test(fields[1]) || !moduleVersionPattern.test(fields[2]) || !moduleSumPattern.test(fields[3])) {
          throw new Error("Ollama Go module inventory contains an invalid dependency record.");
        }
        dependencies.push(Object.freeze({ path: fields[1], version: fields[2], sum: fields[3] }));
      } else if (fields[0] === "build" && fields.length === 2) {
        reachedBuildSettings = true;
        const separator = fields[1].indexOf("=");
        if (separator < 1) throw new Error("Ollama Go build setting is invalid.");
        const key = fields[1].slice(0, separator);
        const value = fields[1].slice(separator + 1);
        if (!key || !value || settings.has(key)) throw new Error("Ollama Go build setting is duplicated or empty.");
        settings.set(key, value);
      } else if (fields[0] === "") {
        break;
      } else {
        break;
      }
    }
    const inventory = `${dependencies.map((entry) => `${entry.path}\t${entry.version}\t${entry.sum}`).join("\n")}\n`;
    const architecture = settings.get("GOARCH");
    if (goVersion !== OLLAMA_RUNTIME_GO_VERSION
      || mainPath !== "github.com/ollama/ollama"
      || mainModule !== "github.com/ollama/ollama"
      || mainVersion !== `v${OLLAMA_RUNTIME_VERSION}+dirty`
      || settings.get("GOOS") !== "darwin"
      || (architecture !== "amd64" && architecture !== "arm64")
      || settings.get("vcs") !== "git"
      || settings.get("vcs.revision") !== OLLAMA_RUNTIME_SOURCE_COMMIT
      || settings.get("vcs.modified") !== "true"
      || dependencies.length !== OLLAMA_RUNTIME_GO_MODULE_COUNT
      || sha256(inventory) !== OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256) {
      throw new Error("Ollama executable build information does not match the exact reviewed runtime legal inventory.");
    }
    records.push(Object.freeze({
      goVersion: OLLAMA_RUNTIME_GO_VERSION,
      mainPath: "github.com/ollama/ollama",
      mainVersion: `v${OLLAMA_RUNTIME_VERSION}+dirty`,
      architecture,
      sourceCommit: OLLAMA_RUNTIME_SOURCE_COMMIT,
      sourceModified: true,
      dependencies: Object.freeze(dependencies),
      dependencyInventorySha256: OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256,
    }));
  }
  if (records.length === 0 || new Set(records.map((entry) => entry.architecture)).size !== records.length) {
    throw new Error("Ollama executable has no unique reviewed Go build-info slice.");
  }
  return Object.freeze(records);
}

function readExactRealFile(pathInput: string, expectedBytes: number, expectedSha256: string, label: string) {
  const path = resolve(pathInput);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || realpathSync(path) !== path
    || status.size !== expectedBytes) {
    throw new Error(`${label} is not the exact reviewed real file.`);
  }
  const source = readFileSync(path);
  if (sha256(source) !== expectedSha256) throw new Error(`${label} does not match its reviewed SHA-256.`);
  return Object.freeze({ path, source, bytes: source.length, sha256: expectedSha256 });
}

export function auditOllamaRuntimeExecutable(pathInput: string, expectedArchitecture: "amd64" | "arm64") {
  const path = resolve(pathInput);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || realpathSync(path) !== path
    || status.size < 1024 * 1024 || status.size > 1024 * 1024 * 1024) {
    throw new Error("Staged Ollama executable is not one bounded real file.");
  }
  const source = readFileSync(path);
  const records = parseOllamaGoBuildInfo(source);
  if (records.length !== 1 || records[0].architecture !== expectedArchitecture) {
    throw new Error("Staged Ollama executable is not the exact reviewed target-architecture slice.");
  }
  return Object.freeze({
    architecture: records[0].architecture,
    goVersion: records[0].goVersion,
    sourceCommit: records[0].sourceCommit,
    sourceModified: records[0].sourceModified,
    compiledGoModules: records[0].dependencies.length,
    compiledGoModuleInventorySha256: records[0].dependencyInventorySha256,
    executableBytes: source.length,
    executableSha256: sha256(source),
  });
}

export function auditOllamaArm64RuntimePayload(runtimeRootInput: string) {
  const runtimeRootCandidate = resolve(runtimeRootInput);
  const rootStatus = lstatSync(runtimeRootCandidate);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("Staged Ollama runtime root must be one real directory.");
  }
  const runtimeRoot = realpathSync(runtimeRootCandidate);
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      const path = join(directory, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error("Staged Ollama arm64 runtime contains a symbolic link.");
      if (status.isDirectory()) visit(path);
      else if (status.isFile() && status.nlink === 1 && realpathSync(path) === path) {
        paths.push(relative(runtimeRoot, path).split(sep).join("/"));
      } else throw new Error("Staged Ollama arm64 runtime contains an unsupported filesystem entry.");
    }
  };
  visit(runtimeRoot);
  const files = paths.map((relativePath) => {
    const path = join(runtimeRoot, relativePath);
    const source = readFileSync(path);
    return Object.freeze({ path: relativePath, bytes: source.length, sha256: sha256(source) });
  });
  const validatedFiles = validateOllamaArm64RuntimeFileIdentities(files);
  const executable = auditOllamaRuntimeExecutable(join(runtimeRoot, "ollama"), "arm64");
  return Object.freeze({ files: validatedFiles, executable });
}

export function inspectOllamaRuntimeLegalNotice(pathInput: string) {
  const value = readExactRealFile(
    pathInput,
    OLLAMA_RUNTIME_NOTICE_BYTES,
    OLLAMA_RUNTIME_NOTICE_SHA256,
    "Ollama runtime legal notice",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value.source);
  if (!text.includes(`Compiled Go modules: ${OLLAMA_RUNTIME_GO_MODULE_COUNT}`)
    || !text.includes(OLLAMA_RUNTIME_GO_MODULE_INVENTORY_SHA256)
    || !text.includes(`Recursive license-like files from exact h1-verified module zips: ${OLLAMA_RUNTIME_GO_LICENSE_FILE_COUNT}`)
    || !text.includes(`Recursive module-license bytes: ${OLLAMA_RUNTIME_GO_LICENSE_BYTES}`)
    || !text.includes(OLLAMA_RUNTIME_GO_LICENSE_INVENTORY_SHA256)
    || !text.includes(OLLAMA_RUNTIME_SOURCE_COMMIT)) {
    throw new Error("Ollama runtime legal notice is missing its reviewed inventory identity.");
  }
  return Object.freeze({ bytes: value.bytes, sha256: value.sha256 });
}
