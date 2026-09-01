import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const packageManifestMaximumBytes = 512 * 1024;
const noticeFileMaximumBytes = 2 * 1024 * 1024;
const noticeMaximumBytes = 16 * 1024 * 1024;
const packageNamePattern = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu;
const packageVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const licenseFilePattern = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu;
const bundledLegalFilePattern = /\.legal\.txt$/iu;

type PackageLockEntry = Readonly<{
  name?: unknown;
  version?: unknown;
  license?: unknown;
}>;

type PackageRecord = Readonly<{
  name?: unknown;
  version?: unknown;
  license?: unknown;
}>;

export type DesktopDependencyNoticeEntry = Readonly<{
  name: string;
  version: string | null;
  declaredLicense: string | null;
  packagedManifestPath: string;
  packagedManifestSha256: string;
  lockOwnerPath: string;
  lockOwnerName: string;
  lockOwnerVersion: string;
  lockOwnerDeclaredLicense: string | null;
  noticeFiles: readonly Readonly<{
    name: string;
    sourcePath: string;
    sourceKind: "owner-root" | "manifest-adjacent" | "reviewed-fallback";
    bytes: number;
    sha256: string;
  }>[];
}>;

export type DesktopDependencyNoticeAudit = Readonly<{
  packageLockSha256: string;
  dependencies: readonly DesktopDependencyNoticeEntry[];
  notice: string;
  noticeBytes: number;
  noticeSha256: string;
}>;

function sha256(source: Buffer | string) {
  return createHash("sha256").update(source).digest("hex");
}

function bytewiseCompare(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizedRelativePath(root: string, path: string) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Packaged dependency path escaped its resource root.");
  }
  return value;
}

function inspectRealDirectory(pathInput: string, label: string) {
  const candidate = resolve(pathInput);
  const status = lstatSync(candidate);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be one real directory.`);
  }
  return realpathSync(candidate);
}

function readRealUtf8File(pathInput: string, maximumBytes: number, label: string) {
  const path = resolve(pathInput);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || realpathSync(path) !== path
    || status.size < 1 || status.size > maximumBytes) {
    throw new Error(`${label} must be one bounded real regular file.`);
  }
  const source = readFileSync(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
  return Object.freeze({ path, source, text: text.replaceAll("\r\n", "\n").replaceAll("\r", "\n") });
}

function packageManifests(root: string) {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => bytewiseCompare(left.name, right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Packaged dependency inventory contains a symbolic link.");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "package.json") output.push(path);
      else if (!entry.isFile()) throw new Error("Packaged dependency inventory contains an unsupported entry.");
    }
  };
  visit(join(root, "node_modules"));
  if (output.length === 0) throw new Error("Packaged dependency inventory is empty.");
  return output;
}

function parsePackageRecord(source: string, label: string): PackageRecord {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object.`);
  return value as PackageRecord;
}

function exactPackageName(value: unknown, label: string) {
  if (typeof value !== "string" || !packageNamePattern.test(value) || value.includes("..")) {
    throw new Error(`${label} has an invalid package name.`);
  }
  return value;
}

function optionalVersion(value: unknown, label: string) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !packageVersionPattern.test(value)) throw new Error(`${label} has an invalid package version.`);
  return value;
}

function optionalLicense(value: unknown, label: string) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\r\n\0]/u.test(value)) {
    throw new Error(`${label} has an invalid license declaration.`);
  }
  return value;
}

function lockOwnerForPath(packagePath: string, packages: Readonly<Record<string, PackageLockEntry>>) {
  const candidates = Object.keys(packages)
    .filter((path) => path.startsWith("node_modules/")
      && (packagePath === `${path}/package.json` || packagePath.startsWith(`${path}/`)))
    .sort((left, right) => right.length - left.length || bytewiseCompare(left, right));
  const path = candidates[0];
  if (!path) throw new Error(`Packaged dependency has no package-lock owner: ${packagePath}.`);
  const record = packages[path];
  const version = optionalVersion(record.version, `package-lock owner ${path}`);
  if (!version) throw new Error(`package-lock owner ${path} has no exact version.`);
  const packageManifestPath = `${path}/package.json`;
  return Object.freeze({
    path,
    packageManifestPath,
    name: typeof record.name === "string" ? exactPackageName(record.name, `package-lock owner ${path}`) : null,
    version,
  });
}

function markdownCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function indentedText(value: string) {
  const normalized = value.endsWith("\n") ? value : `${value}\n`;
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

type NoticeSource = Readonly<{
  path: string;
  sourcePath: string;
  name: string;
  sourceKind: "owner-root" | "manifest-adjacent" | "reviewed-fallback";
  expectedSha256?: string;
}>;

function noticeSourcesInDirectory(input: Readonly<{
  projectRoot: string;
  directory: string;
  sourceKind: "owner-root" | "manifest-adjacent";
  includeBundledLegalFiles: boolean;
}>) {
  const sources: NoticeSource[] = [];
  for (const entry of readdirSync(input.directory, { withFileTypes: true })
    .sort((left, right) => bytewiseCompare(left.name, right.name))) {
    if (!licenseFilePattern.test(entry.name)
      && !(input.includeBundledLegalFiles && bundledLegalFilePattern.test(entry.name))) continue;
    const path = join(input.directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Dependency legal source must be one real regular file: ${normalizedRelativePath(input.projectRoot, path)}.`);
    }
    if (lstatSync(path).size === 0) continue;
    sources.push(Object.freeze({
      path,
      sourcePath: normalizedRelativePath(input.projectRoot, path),
      name: entry.name,
      sourceKind: input.sourceKind,
    }));
  }
  return sources;
}

function reviewedNoticeFallbacks(input: Readonly<{
  projectRoot: string;
  ownerPath: string;
  ownerName: string;
  ownerVersion: string;
  ownerLicense: string | null;
}>): NoticeSource[] {
  const fallback = (sourcePath: string, expectedSha256: string): NoticeSource => Object.freeze({
    path: join(input.projectRoot, sourcePath),
    sourcePath,
    name: sourcePath.split("/").at(-1) ?? sourcePath,
    sourceKind: "reviewed-fallback",
    expectedSha256,
  });
  if (/^@img\/sharp-libvips-[a-z0-9-]+$/u.test(input.ownerName)
    && input.ownerVersion === "1.3.2" && input.ownerLicense === "LGPL-3.0-or-later") {
    return [fallback(`${input.ownerPath}/README.md`, "47083f1ae7e990f74a56f576bcb8434051cb84ed1982fa57932720869e5147fe")];
  }
  if (input.ownerName === "@next/env" && input.ownerVersion === "16.2.12" && input.ownerLicense === "MIT") {
    return [fallback("node_modules/next/license.md", "ee765244e2d59f5234d474f62e0766fa0c8b99af967fdd4c0cb8dcb0c76ea224")];
  }
  if (input.ownerName === "client-only" && input.ownerVersion === "0.0.1" && input.ownerLicense === "MIT") {
    return [fallback("node_modules/react/LICENSE", "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93")];
  }
  if (/^sqlite-vec(?:-[a-z0-9-]+)?$/u.test(input.ownerName)
    && input.ownerVersion === "0.1.9" && input.ownerLicense === "MIT OR Apache") {
    return [fallback(
      "desktop/legal/sqlite-vec-0.1.9-LICENSE-MIT.txt",
      "6ce72bbe12d975bd5286e5ab0a064c069693300c47bccbc57bec18485f1621ea",
    )];
  }
  return [];
}

function reviewedNestedNoticeFallbacks(input: Readonly<{
  projectRoot: string;
  packagePath: string;
  name: string;
  version: string | null;
  declaredLicense: string | null;
  manifestSha256: string;
  ownerName: string;
  ownerVersion: string;
}>): NoticeSource[] {
  const fallback = (sourcePath: string, expectedSha256: string): NoticeSource => Object.freeze({
    path: join(input.projectRoot, sourcePath),
    sourcePath,
    name: sourcePath.split("/").at(-1) ?? sourcePath,
    sourceKind: "reviewed-fallback",
    expectedSha256,
  });
  if (input.ownerName !== "next" || input.ownerVersion !== "16.2.12") return [];
  const edgeRuntimePackages = new Map<string, Readonly<{ name: string; version: string; manifestSha256: string }>>([
    ["node_modules/next/dist/compiled/@edge-runtime/cookies/package.json", Object.freeze({
      name: "@edge-runtime/cookies",
      version: "6.0.0",
      manifestSha256: "84dec8086a6d6a1176ff52a54dbc4542aeca7241214a0cf7d5af2870ee422db2",
    })],
    ["node_modules/next/dist/compiled/@edge-runtime/ponyfill/package.json", Object.freeze({
      name: "@edge-runtime/ponyfill",
      version: "4.0.0",
      manifestSha256: "04d31884423b345e3abddc712adc85e10347ccf057630b23a930f1ba9af56708",
    })],
    ["node_modules/next/dist/compiled/@edge-runtime/primitives/package.json", Object.freeze({
      name: "@edge-runtime/primitives",
      version: "6.0.0",
      manifestSha256: "ee5dfbcb78d0c753908a0643fc23d7486cf4478872789bca8722a88f71d5c213",
    })],
  ]);
  const edgeRuntimePackage = edgeRuntimePackages.get(input.packagePath);
  if (edgeRuntimePackage && input.name === edgeRuntimePackage.name
    && input.version === edgeRuntimePackage.version && input.declaredLicense === "MIT"
    && input.manifestSha256 === edgeRuntimePackage.manifestSha256) {
    return [fallback(
      "node_modules/next/dist/compiled/edge-runtime/LICENSE",
      "e4f76a7a19ef2989dd79339bd3abf8afcf1d6f065e5a10c76c19415ffd727eb3",
    )];
  }
  if (input.packagePath === "node_modules/next/dist/compiled/string-hash/package.json"
    && input.name === "string-hash" && input.version === null && input.declaredLicense === "CC0-1.0"
    && input.manifestSha256 === "afb2563fe191f4e7eecc9e6bf1131f07da3f855e6e51b2d517206ae737b343b0") {
    return [fallback(
      "node_modules/next/dist/compiled/postcss-preset-env/LICENSE",
      "597756adcb51f243ef4fb386920377f61d012ace0904364e1a8ee9aaec6afc84",
    )];
  }
  return [];
}

export function createDesktopDependencyNotice(input: Readonly<{
  projectRoot: string;
  resourceRoot: string;
}>): DesktopDependencyNoticeAudit {
  const projectRoot = inspectRealDirectory(input.projectRoot, "Desktop project root");
  const resourceRoot = inspectRealDirectory(input.resourceRoot, "Desktop resource root");
  const packageLock = readRealUtf8File(join(projectRoot, "package-lock.json"), 8 * 1024 * 1024, "package-lock.json");
  let lock: unknown;
  try {
    lock = JSON.parse(packageLock.text);
  } catch {
    throw new Error("package-lock.json is not valid JSON.");
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)
    || !("packages" in lock) || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("package-lock.json has no package inventory.");
  }
  const packages = lock.packages as Record<string, PackageLockEntry>;
  const noticeTexts = new Map<string, { text: string; files: Set<string>; packages: Set<string> }>();
  const dependencies: DesktopDependencyNoticeEntry[] = [];
  for (const manifestPath of packageManifests(resourceRoot)) {
    const packaged = readRealUtf8File(manifestPath, packageManifestMaximumBytes, "Packaged dependency manifest");
    const packagePath = normalizedRelativePath(resourceRoot, manifestPath);
    const packagedManifestSha256 = sha256(packaged.source);
    const record = parsePackageRecord(packaged.text, `Packaged dependency manifest ${packagePath}`);
    const name = exactPackageName(record.name, `Packaged dependency manifest ${packagePath}`);
    const version = optionalVersion(record.version, `Packaged dependency manifest ${packagePath}`);
    const declaredLicense = optionalLicense(record.license, `Packaged dependency manifest ${packagePath}`);
    const owner = lockOwnerForPath(packagePath, packages);
    const ownerSource = readRealUtf8File(join(projectRoot, owner.packageManifestPath), packageManifestMaximumBytes, `Locked package owner ${owner.path}`);
    const ownerRecord = parsePackageRecord(ownerSource.text, `Locked package owner ${owner.path}`);
    const ownerName = exactPackageName(ownerRecord.name, `Locked package owner ${owner.path}`);
    const ownerVersion = optionalVersion(ownerRecord.version, `Locked package owner ${owner.path}`);
    const ownerLicense = optionalLicense(ownerRecord.license, `Locked package owner ${owner.path}`);
    if (ownerVersion !== owner.version || (owner.name !== null && owner.name !== ownerName)) {
      throw new Error(`Installed package owner does not match package-lock.json: ${owner.path}.`);
    }
    if (packagePath === owner.packageManifestPath
      && (name !== ownerName || version !== ownerVersion || packaged.source.compare(ownerSource.source) !== 0)) {
      throw new Error(`Packaged dependency does not match its locked installed manifest: ${packagePath}.`);
    }
    const installedManifest = packagePath === owner.packageManifestPath
      ? ownerSource
      : readRealUtf8File(join(projectRoot, packagePath), packageManifestMaximumBytes, `Installed nested package manifest ${packagePath}`);
    if (packaged.source.compare(installedManifest.source) !== 0) {
      throw new Error(`Packaged nested dependency does not match its installed manifest: ${packagePath}.`);
    }
    const ownerDirectory = join(projectRoot, owner.path);
    inspectRealDirectory(ownerDirectory, `Installed dependency owner ${ownerName}`);
    let noticeSources: NoticeSource[];
    if (packagePath === owner.packageManifestPath) {
      const ownerNoticeSources = noticeSourcesInDirectory({
        projectRoot,
        directory: ownerDirectory,
        sourceKind: "owner-root",
        includeBundledLegalFiles: false,
      });
      noticeSources = ownerNoticeSources.length > 0 ? ownerNoticeSources : reviewedNoticeFallbacks({
        projectRoot,
        ownerPath: owner.path,
        ownerName,
        ownerVersion: ownerVersion ?? owner.version,
        ownerLicense,
      });
    } else {
      const adjacentSources = noticeSourcesInDirectory({
        projectRoot,
        directory: dirname(installedManifest.path),
        sourceKind: "manifest-adjacent",
        includeBundledLegalFiles: true,
      });
      const adjacentLicenseSources = adjacentSources.filter((entry) => licenseFilePattern.test(entry.name));
      const adjacentBundledLegalSources = adjacentSources.filter((entry) => bundledLegalFilePattern.test(entry.name));
      const baseLicenseSources = adjacentLicenseSources.length > 0 ? adjacentLicenseSources : reviewedNestedNoticeFallbacks({
        projectRoot,
        packagePath,
        name,
        version,
        declaredLicense,
        manifestSha256: packagedManifestSha256,
        ownerName,
        ownerVersion: ownerVersion ?? owner.version,
      });
      noticeSources = [...baseLicenseSources, ...adjacentBundledLegalSources];
    }
    const noticeFiles = noticeSources.map((entry) => {
        const notice = readRealUtf8File(entry.path, noticeFileMaximumBytes, `${ownerName} ${entry.sourcePath}`);
        const digest = sha256(notice.source);
        if (entry.expectedSha256 && digest !== entry.expectedSha256) {
          throw new Error(`Reviewed dependency notice fallback changed: ${entry.sourcePath}.`);
        }
        const identity = `${name}${version ? `@${version}` : ""} (${packagePath})`;
        const existing = noticeTexts.get(digest);
        if (existing) {
          if (existing.text !== notice.text) throw new Error("Dependency notice SHA-256 collision detected.");
          existing.files.add(entry.sourcePath);
          existing.packages.add(identity);
        } else {
          noticeTexts.set(digest, { text: notice.text, files: new Set([entry.sourcePath]), packages: new Set([identity]) });
        }
        return Object.freeze({
          name: entry.name,
          sourcePath: entry.sourcePath,
          sourceKind: entry.sourceKind,
          bytes: notice.source.length,
          sha256: digest,
        });
      });
    if (noticeFiles.length === 0) {
      throw new Error(packagePath === owner.packageManifestPath
        ? `Packaged dependency lock owner has no distributable license or notice text: ${owner.path}.`
        : `Packaged nested dependency has no adjacent or reviewed distributable license text: ${packagePath}.`);
    }
    dependencies.push(Object.freeze({
      name,
      version,
      declaredLicense,
      packagedManifestPath: packagePath,
      packagedManifestSha256,
      lockOwnerPath: owner.path,
      lockOwnerName: ownerName,
      lockOwnerVersion: ownerVersion,
      lockOwnerDeclaredLicense: ownerLicense,
      noticeFiles: Object.freeze(noticeFiles),
    }));
  }
  dependencies.sort((left, right) => bytewiseCompare(left.packagedManifestPath, right.packagedManifestPath));
  const lines = [
    "# Packaged dependency notices",
    "",
    "This file is generated during desktop packaging from the exact dependency manifests traced into the application payload. The generator verifies each root payload manifest against its installed package-lock owner. Every nested vendored manifest must exactly match its installed source manifest and bind to its adjacent legal text; a small exact-version and exact-digest allowlist supplies reviewed text only when an applicable adjacent license file is absent. Declared license identifiers are inventory metadata, not substitutes for retained text. Do not edit this generated file by hand.",
    "",
    `- Package-lock SHA-256: \`${sha256(packageLock.source)}\``,
    `- Packaged dependency manifests: ${dependencies.length}`,
    `- Distinct included license or notice texts: ${noticeTexts.size}`,
    "",
    "## Inventory",
    "",
    "| Package | Version | Declared license | Packaged manifest | Manifest SHA-256 | Lock owner | Included notice files |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...dependencies.map((entry) => `| ${markdownCell(entry.name)} | ${markdownCell(entry.version ?? "bundled")} | ${markdownCell(entry.declaredLicense ?? entry.lockOwnerDeclaredLicense ?? "see included text")} | \`${entry.packagedManifestPath}\` | \`${entry.packagedManifestSha256}\` | ${markdownCell(`${entry.lockOwnerName}@${entry.lockOwnerVersion}`)} | ${markdownCell(entry.noticeFiles.map((file) => `${file.sourceKind}:${file.sourcePath} (${file.sha256})`).join(", ") || "none")} |`),
    "",
    "## Included license and notice texts",
    "",
  ];
  for (const [digest, record] of [...noticeTexts.entries()].sort(([left], [right]) => bytewiseCompare(left, right))) {
    lines.push(
      `### SHA-256 ${digest}`,
      "",
      `Packages: ${[...record.packages].sort(bytewiseCompare).map((value) => `\`${value}\``).join(", ")}`,
      "",
      `Source filenames: ${[...record.files].sort(bytewiseCompare).map((value) => `\`${value}\``).join(", ")}`,
      "",
      indentedText(record.text),
      "",
    );
  }
  const notice = `${lines.join("\n").trimEnd()}\n`;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  if (noticeBytes > noticeMaximumBytes) throw new Error("Generated dependency notice exceeds its permitted size.");
  return Object.freeze({
    packageLockSha256: sha256(packageLock.source),
    dependencies: Object.freeze(dependencies),
    notice,
    noticeBytes,
    noticeSha256: sha256(notice),
  });
}
