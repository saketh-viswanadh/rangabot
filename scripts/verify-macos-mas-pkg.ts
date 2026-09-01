import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectDesktopArtifact,
  parseDesktopArtifactManifest,
  type DesktopArtifactTarget,
} from "../lib/desktop-artifact-identity.ts";
import {
  assertMacAppStoreEntitlements,
  assertMacPackageProductIdentity,
  inspectExpandedMacPackage,
  parseMacApplicationSignature,
  parseMacInstallerSignature,
  reconcileMacPackageBomWithPayload,
  resolveMacInstallerSigningCertificate,
  validateMacPackageMetadata,
  validateMacProvisioningProfile,
} from "../lib/macos-mas-pkg.ts";
import {
  MAC_APP_STORE_BUNDLE_ID,
  buildPlistDictionary,
  decodeProvisioningProfile,
  expectedMacAppStoreChildEntitlements,
  expectedMacAppStoreMainEntitlements,
  readPlistDictionary,
  readCodeSignatureEntitlements,
  resolveMacSigningCertificate,
  validateMacAppStoreProvisioningProfile,
  verifyCompleteMacAppStoreCodeSignature,
} from "../lib/mac-app-store-signing-policy.ts";
import { writeSafeAtomicJsonEvidence } from "../lib/safe-atomic-json-output.ts";
import { assertStableFileUnchanged, inspectStableFile } from "../lib/windows-msix-path-policy.ts";
import {
  OLLAMA_ARM64_RETAINED_RUNTIME_FILES,
  auditOllamaRuntimeExecutable,
  inspectOllamaRuntimeLegalNotice,
} from "../lib/ollama-runtime-legal.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const gitCommitPattern = /^[0-9a-f]{40}$/u;
const packageMaximumBytes = 8 * 1024 * 1024 * 1024;

type PackageProductRecord = Readonly<{
  name?: unknown;
  version?: unknown;
  desktopBuild?: { macBuildNumber?: unknown };
}>;

function parseArguments(arguments_: string[]) {
  const packages = arguments_.filter((argument) => argument.startsWith("--pkg=")).map((argument) => argument.slice(6));
  const architectures = arguments_.filter((argument) => argument.startsWith("--arch=")).map((argument) => argument.slice(7));
  if (arguments_.length !== 2 || packages.length !== 1 || architectures.length !== 1
    || architectures[0] !== "arm64") {
    throw new Error("Mac App Store package verification supports arm64 only.");
  }
  const packagePath = resolve(packages[0]);
  const packageRelativePath = relative(projectRoot, packagePath).split(sep).join("/");
  if (!packages[0].startsWith("/") || !packageRelativePath || packageRelativePath.startsWith("../")
    || packageRelativePath.includes("\\") || !packageRelativePath.endsWith(".pkg")) {
    throw new Error("Mac App Store package must be one absolute .pkg path inside the project checkout.");
  }
  return Object.freeze({ packagePath, packageRelativePath, arch: architectures[0] as DesktopArtifactTarget["arch"] });
}

function requiredEnvironment(name: string, pattern: RegExp) {
  const value = process.env[name];
  if (!value || !pattern.test(value) || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required and invalid.`);
  return value;
}

function checkedOutSource() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  if (!gitCommitPattern.test(commit) || dirty) throw new Error("Mac App Store package verification requires one exact clean source commit.");
  return commit;
}

function packageProductIdentity() {
  const record = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as PackageProductRecord;
  if (record.name !== "rangabot" || typeof record.version !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(record.version)
    || typeof record.desktopBuild?.macBuildNumber !== "string"
    || !/^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/u.test(record.desktopBuild.macBuildNumber)) {
    throw new Error("Source package metadata has no valid Mac product identity.");
  }
  return Object.freeze({ productVersion: record.version, macBuildNumber: record.desktopBuild.macBuildNumber });
}

function commandOutput(command: string, arguments_: string[], label: string) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error(`${label} failed.`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function strictCommandStdout(command: string, arguments_: string[], label: string, maximumBytes = 4 * 1024 * 1024) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", maxBuffer: maximumBytes });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal || result.stderr) throw new Error(`${label} failed.`);
  if (!result.stdout || Buffer.byteLength(result.stdout, "utf8") > maximumBytes || result.stdout.includes("\0")) {
    throw new Error(`${label} returned invalid output.`);
  }
  return result.stdout;
}

function xmlScalar(path: string, expression: string, label: string) {
  const output = strictCommandStdout(
    "/usr/bin/xmllint",
    ["--nonet", "--xpath", `string(${expression})`, path],
    label,
    1024 * 1024,
  );
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (!value || /[\r\n\0]/u.test(value) || Buffer.byteLength(value, "utf8") > 4096) {
    throw new Error(`${label} is not one exact scalar XML value.`);
  }
  return value;
}

function xmlCount(path: string, expression: string, label: string) {
  const output = strictCommandStdout(
    "/usr/bin/xmllint",
    ["--nonet", "--xpath", `count(${expression})`, path],
    label,
    1024 * 1024,
  );
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (!/^\d+$/u.test(value)) throw new Error(`${label} is not one exact XML count.`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`${label} is outside the supported XML count range.`);
  return count;
}

function rejectActiveXmlConstructs(path: string, label: string) {
  const source = readFileSync(path, "utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error(`${label} contains a prohibited document type or entity.`);
}

export function inspectExpandedPackageMetadata(
  distributionPath: string,
  packageInfoPath: string,
  productVersion: string,
  macBuildNumber: string,
) {
  rejectActiveXmlConstructs(distributionPath, "Expanded installer Distribution");
  rejectActiveXmlConstructs(packageInfoPath, "Expanded installer PackageInfo");
  const bundleId = MAC_APP_STORE_BUNDLE_ID;
  return validateMacPackageMetadata({
    distributionRequireScripts: xmlScalar(
      distributionPath,
      "/installer-gui-script/options/@require-scripts",
      "Distribution require-scripts",
    ),
    distributionProductId: xmlScalar(distributionPath, "/installer-gui-script/product/@id", "Distribution product ID"),
    distributionProductVersion: xmlScalar(
      distributionPath,
      "/installer-gui-script/product/@version",
      "Distribution product version",
    ),
    distributionInstallLocation: xmlScalar(
      distributionPath,
      `/installer-gui-script/choice[@id='${bundleId}']/@customLocation`,
      "Distribution install location",
    ),
    distributionPackageReferenceCount: xmlCount(
      distributionPath,
      "/installer-gui-script/pkg-ref",
      "Distribution package-reference count",
    ),
    distributionMatchingPackageReferenceCount: xmlCount(
      distributionPath,
      `/installer-gui-script/pkg-ref[@id='${bundleId}']`,
      "Distribution matching package-reference count",
    ),
    distributionPayloadPackageReferenceCount: xmlCount(
      distributionPath,
      `/installer-gui-script/pkg-ref[normalize-space(text())='#${bundleId}.pkg']`,
      "Distribution payload package-reference count",
    ),
    distributionChoiceCount: xmlCount(distributionPath, "/installer-gui-script/choice", "Distribution choice count"),
    distributionMatchingInstallChoiceCount: xmlCount(
      distributionPath,
      `/installer-gui-script/choice[@id='${bundleId}' and @visible='false' and @customLocation='/Applications']`,
      "Distribution install choice count",
    ),
    distributionMatchingDefaultChoiceCount: xmlCount(
      distributionPath,
      "/installer-gui-script/choice[@id='default']",
      "Distribution default choice count",
    ),
    distributionBundlePath: xmlScalar(
      distributionPath,
      `/installer-gui-script/pkg-ref[@id='${bundleId}']/bundle-version/bundle/@path`,
      "Distribution application path",
    ),
    distributionBundleId: xmlScalar(
      distributionPath,
      `/installer-gui-script/pkg-ref[@id='${bundleId}']/bundle-version/bundle/@id`,
      "Distribution application identifier",
    ),
    distributionBundleProductVersion: xmlScalar(
      distributionPath,
      `/installer-gui-script/pkg-ref[@id='${bundleId}']/bundle-version/bundle/@CFBundleShortVersionString`,
      "Distribution application product version",
    ),
    distributionBundleBuildNumber: xmlScalar(
      distributionPath,
      `/installer-gui-script/pkg-ref[@id='${bundleId}']/bundle-version/bundle/@CFBundleVersion`,
      "Distribution application build number",
    ),
    distributionUnexpectedElementCount: xmlCount(
      distributionPath,
      "/installer-gui-script/*[not(self::pkg-ref or self::product or self::title or self::options or self::volume-check or self::choices-outline or self::choice)]",
      "Distribution unexpected-element count",
    ),
    distributionScriptConstructCount: xmlCount(
      distributionPath,
      "//*[local-name()='script'] | //installation-check | //@script",
      "Distribution script-construct count",
    ),
    distributionUnexpectedInstallChoiceAttributeCount: xmlCount(
      distributionPath,
      `/installer-gui-script/choice[@id='${bundleId}']/@*[not(name()='id' or name()='title' or name()='visible' or name()='customLocation')] | /installer-gui-script/choice[@id='default']/@*[not(name()='id' or name()='title' or name()='versStr')]`,
      "Distribution unexpected choice-attribute count",
    ),
    packageInfoIdentifier: xmlScalar(packageInfoPath, "/pkg-info/@identifier", "PackageInfo identifier"),
    packageInfoVersion: xmlScalar(packageInfoPath, "/pkg-info/@version", "PackageInfo version"),
    packageInfoInstallLocation: xmlScalar(
      packageInfoPath,
      "/pkg-info/@install-location",
      "PackageInfo install location",
    ),
    packageInfoRelocatable: xmlScalar(packageInfoPath, "/pkg-info/@relocatable", "PackageInfo relocatable"),
    packageInfoPostinstallAction: xmlScalar(
      packageInfoPath,
      "/pkg-info/@postinstall-action",
      "PackageInfo postinstall action",
    ),
    packageInfoPayloadCount: xmlCount(packageInfoPath, "/pkg-info/payload", "PackageInfo payload count"),
    packageInfoNumberOfFiles: xmlScalar(
      packageInfoPath,
      "/pkg-info/payload/@numberOfFiles",
      "PackageInfo payload numberOfFiles",
    ),
    packageInfoUnexpectedPayloadAttributeCount: xmlCount(
      packageInfoPath,
      "/pkg-info/payload/@*[not(name()='numberOfFiles' or name()='installKBytes')]",
      "PackageInfo unexpected payload-attribute count",
    ),
    packageInfoBundleCount: xmlCount(packageInfoPath, "/pkg-info/bundle", "PackageInfo bundle count"),
    packageInfoBundlePath: xmlScalar(packageInfoPath, "/pkg-info/bundle/@path", "PackageInfo application path"),
    packageInfoBundleId: xmlScalar(packageInfoPath, "/pkg-info/bundle/@id", "PackageInfo application identifier"),
    packageInfoBundleProductVersion: xmlScalar(
      packageInfoPath,
      "/pkg-info/bundle/@CFBundleShortVersionString",
      "PackageInfo application product version",
    ),
    packageInfoBundleBuildNumber: xmlScalar(
      packageInfoPath,
      "/pkg-info/bundle/@CFBundleVersion",
      "PackageInfo application build number",
    ),
    packageInfoUnexpectedElementCount: xmlCount(
      packageInfoPath,
      "/pkg-info/*[not(self::payload or self::bundle or self::bundle-version or self::upgrade-bundle or self::update-bundle or self::atomic-update-bundle or self::strict-identifier or self::relocate)]",
      "PackageInfo unexpected-element count",
    ),
    packageInfoScriptConstructCount: xmlCount(
      packageInfoPath,
      "//*[local-name()='script'] | //@script",
      "PackageInfo script-construct count",
    ),
    packageInfoUnexpectedRootAttributeCount: xmlCount(
      packageInfoPath,
      "/pkg-info/@*[not(name()='overwrite-permissions' or name()='relocatable' or name()='identifier' or name()='postinstall-action' or name()='version' or name()='format-version' or name()='generator-version' or name()='install-location' or name()='auth' or name()='preserve-xattr')]",
      "PackageInfo unexpected root-attribute count",
    ),
  }, productVersion, macBuildNumber);
}

function plistValue(path: string, keyPath: string, label: string) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", keyPath, "raw", "-o", "-", path], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error(`${label} is missing or invalid.`);
  const value = result.stdout.trim();
  if (!value || /[\r\n\0]/u.test(value)) throw new Error(`${label} is not one exact scalar value.`);
  return value;
}

function optionalPlistValue(path: string, keyPath: string) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", keyPath, "raw", "-o", "-", path], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) return null;
  const value = result.stdout.trim();
  if (!value || /[\r\n\0]/u.test(value)) throw new Error("Optional provisioning-profile value is invalid.");
  return value;
}

function packageEvidenceName(arch: DesktopArtifactTarget["arch"]) {
  return `macos-mas-pkg-darwin-${arch}.json`;
}

function legalPayload(manifest: NonNullable<ReturnType<typeof parseDesktopArtifactManifest>>) {
  return [
    "LICENSE",
    "DEPENDENCY_NOTICES.md",
    "THIRD_PARTY_NOTICES.md",
    "ELECTRON_LICENSE",
    "ELECTRON_CHROMIUM_LICENSES.html",
    "OLLAMA_RUNTIME_NOTICES.md",
  ].map((name) => {
    const path = `rangabot-resources/${name}`;
    const entry = manifest.resources.find((candidate) => candidate.path === path);
    if (!entry) throw new Error(`Mac App Store application is missing identity-bound legal payload ${path}.`);
    return Object.freeze({ path, bytes: entry.bytes, sha256: entry.sha256 });
  });
}

export async function verifyMacAppStorePackage(arguments_ = process.argv.slice(2)) {
  if (process.platform !== "darwin") throw new Error("Mac App Store package verification must run on macOS.");
  if (process.env.RANGABOT_DESKTOP_DISTRIBUTION !== "mas-distribution") {
    throw new Error("Mac App Store package verification requires the exact mas-distribution mode.");
  }
  const input = parseArguments(arguments_);
  if (process.arch !== input.arch) throw new Error("Mac App Store package verification must run on its target architecture.");
  const teamId = requiredEnvironment("RANGABOT_MAC_TEAM_ID", /^[A-Z0-9]{10}$/u);
  const applicationSigningIdentity = requiredEnvironment("RANGABOT_MAC_APP_SIGNING_IDENTITY", /^[^\r\n]{3,256}$/u);
  const installerSigningIdentity = requiredEnvironment("RANGABOT_MAC_INSTALLER_SIGNING_IDENTITY", /^[^\r\n]{3,256}$/u);
  const applicationSigningCertificate = resolveMacSigningCertificate(applicationSigningIdentity);
  if (applicationSigningCertificate.organizationalUnit !== teamId) {
    throw new Error("The resolved application signing certificate is not owned by the configured Apple Team ID.");
  }
  const installerSigningCertificate = resolveMacInstallerSigningCertificate(installerSigningIdentity, teamId);
  const sourceCommit = checkedOutSource();
  const product = packageProductIdentity();
  const expectedPackageName = `RangaBot-${product.productVersion}-build-${product.macBuildNumber}-${input.arch}-Mac-App-Store.pkg`;
  if (basename(input.packagePath) !== expectedPackageName) throw new Error("Mac App Store package filename does not match its exact product identity.");
  const packageFile = inspectStableFile(input.packagePath, {
    label: "Mac App Store installer package",
    maximumBytes: packageMaximumBytes,
  });
  const signatureOutput = commandOutput("/usr/sbin/pkgutil", ["--check-signature", input.packagePath], "Installer signature verification");
  const installerSignature = parseMacInstallerSignature(signatureOutput, installerSigningCertificate, teamId);
  assertStableFileUnchanged(packageFile, "Mac App Store installer package");

  const temporaryRoot = mkdtempSync(join(tmpdir(), "rangabot-mas-pkg-"));
  chmodSync(temporaryRoot, 0o700);
  try {
    const expandedRoot = join(temporaryRoot, "expanded");
    execFileSync("/usr/sbin/pkgutil", ["--expand-full", input.packagePath, expandedRoot], {
      stdio: "inherit",
      maxBuffer: 16 * 1024 * 1024,
    });
    assertStableFileUnchanged(packageFile, "Mac App Store installer package");
    const expandedPackage = inspectExpandedMacPackage(expandedRoot);
    const distributionFile = inspectStableFile(expandedPackage.distributionPath, {
      label: "Expanded installer Distribution",
      maximumBytes: 4 * 1024 * 1024,
    });
    const packageInfoFile = inspectStableFile(expandedPackage.packageInfoPath, {
      label: "Expanded installer PackageInfo",
      maximumBytes: 4 * 1024 * 1024,
    });
    const bomFile = inspectStableFile(expandedPackage.bomPath, {
      label: "Expanded installer BOM",
      maximumBytes: 128 * 1024 * 1024,
    });
    const packageMetadata = inspectExpandedPackageMetadata(
      expandedPackage.distributionPath,
      expandedPackage.packageInfoPath,
      product.productVersion,
      product.macBuildNumber,
    );
    const bomSource = strictCommandStdout(
      "/usr/bin/lsbom",
      ["-p", "mf", expandedPackage.bomPath],
      "Expanded installer BOM inspection",
      64 * 1024 * 1024,
    );
    const bom = reconcileMacPackageBomWithPayload(
      bomSource,
      expandedPackage.payloadPath,
      packageMetadata.packageInfoNumberOfFiles,
    );
    assertStableFileUnchanged(distributionFile, "Expanded installer Distribution");
    assertStableFileUnchanged(packageInfoFile, "Expanded installer PackageInfo");
    assertStableFileUnchanged(bomFile, "Expanded installer BOM");
    const appPath = expandedPackage.appPath;
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
    const applicationSignature = parseMacApplicationSignature(
      commandOutput("/usr/bin/codesign", ["--display", "--verbose=4", appPath], "Application signature inspection"),
      applicationSigningCertificate.commonName,
      teamId,
    );
    assertMacAppStoreEntitlements(buildPlistDictionary(readCodeSignatureEntitlements(appPath)));

    const contentsRoot = join(appPath, "Contents");
    const infoPlistPath = join(contentsRoot, "Info.plist");
    const infoPlist = inspectStableFile(infoPlistPath, {
      label: "Expanded application Info.plist",
      maximumBytes: 1024 * 1024,
      requireSingleLink: false,
    });
    const bundleIdentifier = plistValue(infoPlistPath, "CFBundleIdentifier", "CFBundleIdentifier");
    const marketingVersion = plistValue(infoPlistPath, "CFBundleShortVersionString", "CFBundleShortVersionString");
    const buildNumber = plistValue(infoPlistPath, "CFBundleVersion", "CFBundleVersion");
    assertStableFileUnchanged(infoPlist, "Expanded application Info.plist");

    const artifactRoot = join(contentsRoot, "Resources");
    const manifestPath = join(artifactRoot, "rangabot-resources", "desktop", "manifest.json");
    const manifestFile = inspectStableFile(manifestPath, {
      label: "Expanded desktop artifact manifest",
      maximumBytes: 16 * 1024 * 1024,
      captureContent: true,
      requireSingleLink: false,
    });
    const manifest = parseDesktopArtifactManifest(JSON.parse(manifestFile.content?.toString("utf8") ?? ""));
    if (!manifest || manifest.target.platform !== "darwin" || manifest.target.arch !== input.arch
      || manifest.sourceDirty || manifest.sourceCommit !== sourceCommit
      || manifest.productVersion !== product.productVersion || manifest.macBuildNumber !== product.macBuildNumber
      || manifest.packagingTooling.signature.mode !== "app-store-distribution"
      || !manifest.packagingTooling.signature.postFuseMutation
      || !manifest.packagingTooling.signature.deepStrictVerified) {
      throw new Error("Expanded application manifest is not the exact signed distribution candidate.");
    }
    assertMacPackageProductIdentity({
      bundleIdentifier,
      marketingVersion,
      buildNumber,
      expectedProductVersion: manifest.productVersion,
      expectedBuildNumber: manifest.macBuildNumber,
    });
    const verifiedArtifact = inspectDesktopArtifact({
      resourceRoot: artifactRoot,
      manifestPath,
      runtime: {
        platform: "darwin",
        arch: input.arch,
        electron: manifest.runtimeVersions.electron,
        embeddedNode: manifest.runtimeVersions.embeddedNode,
        next: manifest.runtimeVersions.next,
        nativeModules: manifest.runtimeVersions.nativeModules,
      },
    });
    if (verifiedArtifact.state !== "known" || verifiedArtifact.reason !== "known"
      || verifiedArtifact.artifactSha256 !== manifest.desktopArtifactId
      || verifiedArtifact.productVersion !== manifest.productVersion
      || verifiedArtifact.macBuildNumber !== manifest.macBuildNumber) {
      throw new Error("Expanded application failed exact desktop artifact identity verification.");
    }
    const runtimePrefix = "rangabot-resources/runtime/ollama/";
    const packagedRuntimeFiles = manifest.resources
      .filter((entry) => entry.path.startsWith(runtimePrefix))
      .map((entry) => Object.freeze({
        path: entry.path.slice(runtimePrefix.length),
        bytes: entry.bytes,
        sha256: entry.sha256,
      }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const reviewedUnsignedRuntimeFiles = OLLAMA_ARM64_RETAINED_RUNTIME_FILES
      .map((entry) => Object.freeze({ ...entry }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    if (JSON.stringify(packagedRuntimeFiles.map((entry) => entry.path))
      !== JSON.stringify(reviewedUnsignedRuntimeFiles.map((entry) => entry.path))) {
      throw new Error("Expanded application does not contain the exact reviewed Ollama arm64 runtime paths.");
    }
    for (const reviewed of reviewedUnsignedRuntimeFiles.filter((entry) => entry.path.endsWith(".metallib"))) {
      const packaged = packagedRuntimeFiles.find((entry) => entry.path === reviewed.path);
      if (packaged?.sha256 !== reviewed.sha256) {
        throw new Error(`Expanded application changed unsigned Ollama runtime asset ${reviewed.path}.`);
      }
    }
    const finalOllamaExecutable = auditOllamaRuntimeExecutable(join(
      artifactRoot,
      "rangabot-resources",
      "runtime",
      "ollama",
      "ollama",
    ), "arm64");
    const finalOllamaManifestEntry = packagedRuntimeFiles.find((entry) => entry.path === "ollama");
    if (!finalOllamaManifestEntry
      || finalOllamaManifestEntry.bytes !== finalOllamaExecutable.executableBytes
      || finalOllamaManifestEntry.sha256 !== finalOllamaExecutable.executableSha256) {
      throw new Error("Expanded Ollama executable does not match its final signed resource identity.");
    }
    const ollamaRuntimeLegalNotice = inspectOllamaRuntimeLegalNotice(join(
      artifactRoot,
      "rangabot-resources",
      "OLLAMA_RUNTIME_NOTICES.md",
    ));
    assertStableFileUnchanged(manifestFile, "Expanded desktop artifact manifest");

    const profilePath = join(contentsRoot, "embedded.provisionprofile");
    const profileFile = inspectStableFile(profilePath, {
      label: "Embedded Mac App Store provisioning profile",
      maximumBytes: 4 * 1024 * 1024,
      requireSingleLink: false,
    });
    const decodedProfile = join(temporaryRoot, "embedded-profile.plist");
    execFileSync("/usr/bin/security", ["cms", "-D", "-i", profilePath, "-o", decodedProfile], {
      stdio: "inherit",
      maxBuffer: 4 * 1024 * 1024,
    });
    const getTaskAllowValue = optionalPlistValue(decodedProfile, "Entitlements.get-task-allow");
    const profile = validateMacProvisioningProfile({
      name: plistValue(decodedProfile, "Name", "Provisioning profile name"),
      uuid: plistValue(decodedProfile, "UUID", "Provisioning profile UUID"),
      teamId: plistValue(decodedProfile, "TeamIdentifier.0", "Provisioning profile TeamIdentifier"),
      applicationIdentifier: plistValue(
        decodedProfile,
        "Entitlements.com\\.apple\\.application-identifier",
        "Provisioning profile application identifier",
      ),
      platform: plistValue(decodedProfile, "Platform.0", "Provisioning profile platform"),
      expiresAt: plistValue(decodedProfile, "ExpirationDate", "Provisioning profile expiration"),
      sha256: profileFile.sha256,
      hasAdditionalTeamIdentifier: optionalPlistValue(decodedProfile, "TeamIdentifier.1") !== null,
      hasAdditionalPlatform: optionalPlistValue(decodedProfile, "Platform.1") !== null,
      hasProvisionedDevices: optionalPlistValue(decodedProfile, "ProvisionedDevices.0") !== null,
      getTaskAllow: getTaskAllowValue === null ? null : getTaskAllowValue === "true",
    }, teamId);
    if (getTaskAllowValue !== null && getTaskAllowValue !== "true" && getTaskAllowValue !== "false") {
      throw new Error("Provisioning profile get-task-allow is invalid.");
    }
    const validatedProfile = validateMacAppStoreProvisioningProfile({
      profile: decodeProvisioningProfile(profilePath),
      certificate: applicationSigningCertificate,
      mode: "app-store-distribution",
      teamId,
    });
    const exactMainEntitlements = expectedMacAppStoreMainEntitlements(
      readPlistDictionary(resolve(projectRoot, "desktop", "mas", "entitlements.plist"), "Main entitlement template"),
      validatedProfile,
      teamId,
    );
    const exactChildEntitlements = expectedMacAppStoreChildEntitlements(
      readPlistDictionary(resolve(projectRoot, "desktop", "mas", "entitlements.inherit.plist"), "Child entitlement template"),
    );
    const signatureInventory = verifyCompleteMacAppStoreCodeSignature({
      appPath,
      mainExecutablePath: join(contentsRoot, "MacOS", "RangaBot"),
      teamId,
      certificate: applicationSigningCertificate,
      mainEntitlements: exactMainEntitlements,
      childEntitlements: exactChildEntitlements,
    });
    assertStableFileUnchanged(profileFile, "Embedded Mac App Store provisioning profile");
    const finalExpandedPackage = inspectExpandedMacPackage(expandedRoot);
    if (JSON.stringify(finalExpandedPackage) !== JSON.stringify(expandedPackage)) {
      throw new Error("Expanded installer topology changed while the package was verified.");
    }
    assertStableFileUnchanged(distributionFile, "Expanded installer Distribution");
    assertStableFileUnchanged(packageInfoFile, "Expanded installer PackageInfo");
    assertStableFileUnchanged(bomFile, "Expanded installer BOM");
    const finalBom = reconcileMacPackageBomWithPayload(
      strictCommandStdout(
        "/usr/bin/lsbom",
        ["-p", "mf", finalExpandedPackage.bomPath],
        "Final expanded installer BOM inspection",
        64 * 1024 * 1024,
      ),
      finalExpandedPackage.payloadPath,
      packageMetadata.packageInfoNumberOfFiles,
    );
    if (JSON.stringify(finalBom) !== JSON.stringify(bom)) {
      throw new Error("Expanded installer BOM or payload inventory changed while the package was verified.");
    }
    assertStableFileUnchanged(packageFile, "Mac App Store installer package");
    if (checkedOutSource() !== sourceCommit
      || JSON.stringify(packageProductIdentity()) !== JSON.stringify(product)) {
      throw new Error("Source identity changed while the Mac App Store package was verified.");
    }

    const evidencePath = resolve(projectRoot, "desktop", "out", packageEvidenceName(input.arch));
    const legal = legalPayload(manifest);
    writeSafeAtomicJsonEvidence(evidencePath, {
      schemaVersion: 1,
      state: "SIGNED_MAS_PKG_VERIFIED",
      generatedAt: new Date().toISOString(),
      sourceCommit,
      platform: "darwin",
      arch: input.arch,
      distribution: "mas-distribution",
      package: {
        path: input.packageRelativePath,
        bytes: packageFile.bytes,
        sha256: packageFile.sha256,
      },
      installerSignature,
      expandedPackage: {
        componentPackagesFound: 1,
        payloadApplicationsFound: 1,
        unexpectedEntriesFound: 0,
        installerScriptsFound: packageMetadata.installerScriptsFound,
        componentIdentifier: packageMetadata.componentIdentifier,
        componentPackage: packageMetadata.componentPackage,
        installLocation: packageMetadata.installLocation,
        productVersion: packageMetadata.productVersion,
        macBuildNumber: packageMetadata.macBuildNumber,
        distributionPackageReferences: packageMetadata.distributionPackageReferences,
        bomEntries: bom.entries,
        payloadEntries: bom.payloadEntries,
        bomMetadataEntries: bom.metadataEntries,
        bomPayloadRoot: bom.payloadRoot,
        bomInventorySha256: bom.bomInventorySha256,
        payloadInventorySha256: bom.payloadInventorySha256,
        packageInfoNumberOfFiles: packageMetadata.packageInfoNumberOfFiles,
      },
      application: {
        bundleName: "RangaBot.app",
        bundleIdentifier,
        productVersion: manifest.productVersion,
        macBuildNumber: manifest.macBuildNumber,
        desktopArtifactId: manifest.desktopArtifactId,
        resourceManifestSha256: manifest.resourceManifestSha256,
        nativeManifestSha256: manifest.nativeManifestSha256,
        bundleManifestSha256: manifest.bundleManifestSha256,
        signature: applicationSignature,
        signingCertificate: {
          sha1: applicationSigningCertificate.sha1.toLowerCase(),
          sha256: createHash("sha256").update(Buffer.from(applicationSigningCertificate.derBase64, "base64")).digest("hex"),
          commonName: applicationSigningCertificate.commonName,
          organizationalUnit: applicationSigningCertificate.organizationalUnit,
          issuerCommonName: applicationSigningCertificate.issuerCommonName,
          validFrom: applicationSigningCertificate.validFrom.toISOString(),
          validTo: applicationSigningCertificate.validTo.toISOString(),
        },
        signatureInventory,
        provisioningProfile: profile,
        outerApplicationsFound: 1,
      },
      legalPayload: legal,
      ollamaRuntimeLegal: {
        reviewedUnsignedRuntimeFiles,
        finalSignedRuntimeFiles: packagedRuntimeFiles,
        finalExecutableBuildInfo: finalOllamaExecutable,
        notice: ollamaRuntimeLegalNotice,
        unsignedRuntimeBytesAuditedBy: "source-bound finalizer before code signing",
        finalRuntimeBytesBoundBy: "desktop artifact resource manifest and complete code-signature inventory",
      },
      cleanAccountAcceptance: "NOT_RUN",
      testFlightAcceptance: "NOT_RUN",
      appReview: "NOT_RUN",
      publicReleaseEligible: false,
    }, "Mac App Store signed package evidence");
    assertStableFileUnchanged(packageFile, "Mac App Store installer package");
    console.log(JSON.stringify({
      state: "SIGNED_MAS_PKG_VERIFIED",
      release: "HOLD",
      productVersion: manifest.productVersion,
      macBuildNumber: manifest.macBuildNumber,
      sourceCommit,
      packagePath: input.packageRelativePath,
      packageBytes: packageFile.bytes,
      packageSha256: packageFile.sha256,
      installerIdentity: installerSignature.identity,
      installerCertificateSha256: installerSignature.certificateSha256,
      teamId,
      desktopArtifactId: manifest.desktopArtifactId,
      evidencePath: relative(projectRoot, evidencePath).split(sep).join("/"),
      cleanAccountAcceptance: "NOT_RUN",
      testFlightAcceptance: "NOT_RUN",
    }, null, 2));
    return evidencePath;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyMacAppStorePackage();
