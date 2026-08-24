import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MAC_APP_STORE_BUNDLE_ID,
  type MacSigningCertificate,
} from "./mac-app-store-signing-policy.ts";

const teamIdPattern = /^[A-Z0-9]{10}$/u;
const certificateSha1Pattern = /^[0-9A-F]{40}$/u;
const certificateFingerprintPattern = /^[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const acceptedInstallerStatuses = new Set([
  "signed by a developer certificate issued by Apple",
  "signed by a developer certificate issued by Apple (Development)",
  "signed by a developer certificate issued by Apple for distribution",
  "signed by a certificate trusted by Mac OS X",
]);
const acceptedAppleRoots = new Set(["Apple Root CA", "Apple Root CA - G3"]);

function bytewiseCompare(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactSingleLine(value: string, label: string, maximumBytes = 512) {
  if (!value || Buffer.byteLength(value, "utf8") > maximumBytes || /[\r\n\0]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function exactMatches(source: string, expression: RegExp) {
  return [...source.matchAll(expression)];
}

function parseSha256FingerprintBlock(source: string) {
  const lines = source.split("\n");
  const labels = lines.flatMap((line, index) => {
    const match = /^\s*SHA256 Fingerprint:[ \t]*(.*?)\s*$/u.exec(line);
    return match ? [{ index, first: match[1] }] : [];
  });
  if (labels.length !== 1) throw new Error("Installer certificate has no unique SHA-256 fingerprint.");
  const chunks: string[] = [];
  if (labels[0].first) chunks.push(labels[0].first);
  for (let index = labels[0].index + 1; index < lines.length; index += 1) {
    const value = lines[index].trim();
    if (!/^(?:[0-9A-Fa-f]{2})(?:[ \t]+[0-9A-Fa-f]{2})*$/u.test(value)) break;
    chunks.push(value);
  }
  if (chunks.length === 0 || chunks.some((chunk) => (
    !/^(?:[0-9A-Fa-f]{2})(?:[ \t]+[0-9A-Fa-f]{2})*$/u.test(chunk)
  ))) {
    throw new Error("Installer certificate SHA-256 fingerprint is invalid.");
  }
  const fingerprint = chunks.join(" ").replaceAll(/[ \t]/gu, "").toLowerCase();
  if (!certificateFingerprintPattern.test(fingerprint)) {
    throw new Error("Installer certificate SHA-256 fingerprint is invalid.");
  }
  return fingerprint;
}

function normalizedSha1(value: string) {
  return value.replaceAll(":", "").toUpperCase();
}

function distinguishedNameValue(value: string, key: string) {
  const line = value.split(/\n/u).find((entry) => entry.startsWith(`${key}=`));
  if (line) return line.slice(key.length + 1);
  const slash = value.split("/").find((entry) => entry.startsWith(`${key}=`));
  return slash?.slice(key.length + 1) ?? "";
}

function certificateFromX509(certificate: X509Certificate): MacSigningCertificate {
  const commonName = distinguishedNameValue(certificate.subject, "CN");
  const organizationalUnit = distinguishedNameValue(certificate.subject, "OU");
  const issuerCommonName = distinguishedNameValue(certificate.issuer, "CN");
  if (!commonName || !organizationalUnit || !issuerCommonName) {
    throw new Error("The selected installer certificate has incomplete subject or issuer metadata.");
  }
  return Object.freeze({
    sha1: normalizedSha1(certificate.fingerprint),
    derBase64: certificate.raw.toString("base64"),
    commonName,
    organizationalUnit,
    issuerCommonName,
    validFrom: new Date(certificate.validFrom),
    validTo: new Date(certificate.validTo),
  });
}

function validInstallerIdentities() {
  // Apple's packaging guidance explicitly says not to use the codesigning
  // policy here: installer identities are certificate/private-key identities,
  // but are not application code-signing identities.
  const output = execFileSync("/usr/bin/security", ["find-identity", "-v"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const identities: Array<{ sha1: string; name: string }> = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(.*)"\s*$/u.exec(line);
    if (match) identities.push({ sha1: match[1].toUpperCase(), name: match[2] });
  }
  return identities;
}

export type ResolvedMacInstallerCertificate = Readonly<MacSigningCertificate & {
  sha256: string;
}>;

export function validateMacInstallerCertificate(
  certificate: MacSigningCertificate,
  expectedTeamIdInput: string,
  now = new Date(),
): ResolvedMacInstallerCertificate {
  const expectedTeamId = exactSingleLine(expectedTeamIdInput, "Expected Apple Team ID", 10);
  const commonName = exactSingleLine(certificate.commonName, "Installer certificate common name");
  const organizationalUnit = exactSingleLine(certificate.organizationalUnit, "Installer certificate organizational unit", 64);
  const issuerCommonName = exactSingleLine(certificate.issuerCommonName, "Installer certificate issuer");
  const sha1 = normalizedSha1(certificate.sha1);
  if (!teamIdPattern.test(expectedTeamId)
    || !certificateSha1Pattern.test(sha1)
    || !/^(?:3rd Party Mac Developer Installer|Mac Installer Distribution): .+$/u.test(commonName)
    || organizationalUnit !== expectedTeamId
    || !/^Apple Worldwide Developer Relations Certification Authority(?: G\d+)?$/u.test(issuerCommonName)
    || !Number.isFinite(certificate.validFrom.getTime())
    || !Number.isFinite(certificate.validTo.getTime())
    || !Number.isFinite(now.getTime())
    || certificate.validFrom.getTime() > now.getTime()
    || certificate.validTo.getTime() <= now.getTime()) {
    throw new Error("Installer certificate type, team, issuer, fingerprint, or validity is not an exact current Mac App Store identity.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(certificate.derBase64)) {
    throw new Error("Installer certificate DER is invalid.");
  }
  const der = Buffer.from(certificate.derBase64, "base64");
  if (der.length === 0 || der.toString("base64") !== certificate.derBase64) {
    throw new Error("Installer certificate DER is invalid.");
  }
  return Object.freeze({
    ...certificate,
    sha1,
    commonName,
    organizationalUnit,
    issuerCommonName,
    sha256: createHash("sha256").update(der).digest("hex"),
  });
}

export function resolveMacInstallerSigningCertificate(identityInput: string, expectedTeamId: string) {
  const identity = exactSingleLine(identityInput, "Expected installer signing identity");
  const identitySha1 = normalizedSha1(identity);
  const fingerprintInput = certificateSha1Pattern.test(identitySha1);
  const matches = validInstallerIdentities().filter((candidate) => (
    fingerprintInput ? candidate.sha1 === identitySha1 : candidate.name === identity
  ));
  if (matches.length !== 1) {
    throw new Error("The Mac App Store installer identity must resolve to exactly one valid certificate/private-key identity.");
  }

  const pemOutput = execFileSync("/usr/bin/security", ["find-certificate", "-a", "-p"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const certificates = pemOutput.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  const selected = certificates
    .map((pem) => certificateFromX509(new X509Certificate(pem)))
    .filter((certificate) => certificate.sha1 === matches[0].sha1);
  if (selected.length !== 1 || selected[0].commonName !== matches[0].name) {
    throw new Error("The selected installer certificate could not be resolved unambiguously from the Keychain.");
  }
  return validateMacInstallerCertificate(selected[0], expectedTeamId);
}

export type MacInstallerSignature = Readonly<{
  status: string;
  identity: string;
  teamId: string;
  certificateSha1: string;
  certificateSha256: string;
  certificateIssuer: string;
  certificateValidFrom: string;
  certificateExpiresAt: string;
  trustedTimestamp: string;
}>;

export function parseMacInstallerSignature(
  sourceInput: string,
  expectedCertificateInput: MacSigningCertificate,
  expectedTeamIdInput: string,
): MacInstallerSignature {
  const source = sourceInput.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!source || Buffer.byteLength(source, "utf8") > 1024 * 1024 || source.includes("\0")) {
    throw new Error("Installer signature output is invalid.");
  }
  const expectedCertificate = validateMacInstallerCertificate(expectedCertificateInput, expectedTeamIdInput);
  const expectedIdentity = expectedCertificate.commonName;
  const expectedTeamId = expectedCertificate.organizationalUnit;
  const statuses = exactMatches(source, /^\s*Status:\s*(.+?)\s*$/gmu);
  if (statuses.length !== 1) throw new Error("Installer signature output has no unique status.");
  const status = statuses[0][1];
  if (!acceptedInstallerStatuses.has(status)) {
    throw new Error("Installer package does not have a recognized trusted Apple signature status.");
  }
  const timestampMatches = exactMatches(source, /^\s*Signed with a trusted timestamp on:\s*(.+?)\s*$/gmu);
  if (timestampMatches.length !== 1) throw new Error("Installer signature has no unique trusted timestamp.");
  const trustedTimestamp = exactSingleLine(timestampMatches[0][1], "Installer trusted timestamp");
  const timestamp = Date.parse(trustedTimestamp);
  if (!Number.isFinite(timestamp)
    || timestamp < expectedCertificate.validFrom.getTime()
    || timestamp > Date.now()
    || timestamp >= expectedCertificate.validTo.getTime()) {
    throw new Error("Installer trusted timestamp is outside the signing certificate validity window.");
  }
  const chain = exactMatches(source, /^\s*(\d+)\.\s+(.+?)\s*$/gmu);
  if (chain.length !== 3 || chain[0][1] !== "1" || chain[0][2] !== expectedIdentity
    || chain[1][1] !== "2" || chain[1][2] !== expectedCertificate.issuerCommonName
    || chain[2][1] !== "3" || !acceptedAppleRoots.has(chain[2][2])) {
    throw new Error("Installer certificate chain does not match the resolved Apple identity.");
  }
  const leafStart = chain[0].index ?? -1;
  const nextCertificateStart = chain[1].index ?? -1;
  if (leafStart < 0 || nextCertificateStart <= leafStart) throw new Error("Installer certificate chain is incomplete.");
  const leafSection = source.slice(leafStart, nextCertificateStart);
  const certificateSha256 = parseSha256FingerprintBlock(leafSection);
  if (certificateSha256 !== expectedCertificate.sha256) {
    throw new Error("Installer package leaf certificate does not match the resolved Keychain certificate fingerprint.");
  }
  const expirations = exactMatches(leafSection, /^\s*Expires:\s*(.+?)\s*$/gmu);
  if (expirations.length !== 1) throw new Error("Installer certificate has no unique expiration.");
  const displayedExpiration = Date.parse(exactSingleLine(expirations[0][1], "Installer certificate expiration"));
  if (!Number.isFinite(displayedExpiration)
    || displayedExpiration !== expectedCertificate.validTo.getTime()) {
    throw new Error("Installer certificate expiration does not match the resolved Keychain certificate.");
  }
  return Object.freeze({
    status,
    identity: expectedIdentity,
    teamId: expectedTeamId,
    certificateSha1: expectedCertificate.sha1.toLowerCase(),
    certificateSha256,
    certificateIssuer: expectedCertificate.issuerCommonName,
    certificateValidFrom: expectedCertificate.validFrom.toISOString(),
    certificateExpiresAt: expectedCertificate.validTo.toISOString(),
    trustedTimestamp,
  });
}

export function findOneOuterMacApplication(expandedRootInput: string) {
  return inspectExpandedMacPackage(expandedRootInput).appPath;
}

const expandedComponentName = `${MAC_APP_STORE_BUNDLE_ID}.pkg`;

function exactDirectoryEntries(directory: string, expected: readonly string[], label: string) {
  const actual = readdirSync(directory).sort(bytewiseCompare);
  const sortedExpected = [...expected].sort(bytewiseCompare);
  if (actual.length !== sortedExpected.length
    || actual.some((entry, index) => entry !== sortedExpected[index])) {
    throw new Error(`${label} has unexpected or missing entries.`);
  }
}

function inspectRealExpandedDirectory(pathInput: string, label: string) {
  const path = resolve(pathInput);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`${label} must be one real directory.`);
  }
  return path;
}

function inspectRealExpandedFile(pathInput: string, maximumBytes: number, label: string) {
  const path = resolve(pathInput);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1
    || realpathSync(path) !== path || status.size < 1 || status.size > maximumBytes) {
    throw new Error(`${label} must be one bounded real regular file.`);
  }
  return path;
}

export type ExpandedMacPackage = Readonly<{
  expandedRoot: string;
  distributionPath: string;
  componentPath: string;
  packageInfoPath: string;
  bomPath: string;
  payloadPath: string;
  appPath: string;
}>;

export function inspectExpandedMacPackage(expandedRootInput: string): ExpandedMacPackage {
  const expandedRootCandidate = resolve(expandedRootInput);
  const rootStatus = lstatSync(expandedRootCandidate);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("Expanded installer root must be one real directory.");
  }
  // macOS can spell its temporary root through /var rather than /private/var.
  // Resolve that system alias once, then require every child path to remain exact.
  const expandedRoot = realpathSync(expandedRootCandidate);
  exactDirectoryEntries(expandedRoot, ["Distribution", expandedComponentName], "Expanded installer root");
  const distributionPath = inspectRealExpandedFile(
    join(expandedRoot, "Distribution"),
    4 * 1024 * 1024,
    "Expanded installer Distribution",
  );
  const componentPath = inspectRealExpandedDirectory(
    join(expandedRoot, expandedComponentName),
    "Expanded installer component package",
  );
  exactDirectoryEntries(componentPath, ["Bom", "PackageInfo", "Payload"], "Expanded installer component package");
  const bomPath = inspectRealExpandedFile(join(componentPath, "Bom"), 128 * 1024 * 1024, "Expanded installer BOM");
  const packageInfoPath = inspectRealExpandedFile(
    join(componentPath, "PackageInfo"),
    4 * 1024 * 1024,
    "Expanded installer PackageInfo",
  );
  const payloadPath = inspectRealExpandedDirectory(join(componentPath, "Payload"), "Expanded installer payload");
  exactDirectoryEntries(payloadPath, ["RangaBot.app"], "Expanded installer payload");
  const appPath = inspectRealExpandedDirectory(join(payloadPath, "RangaBot.app"), "Expanded RangaBot application");
  return Object.freeze({
    expandedRoot,
    distributionPath,
    componentPath,
    packageInfoPath,
    bomPath,
    payloadPath,
    appPath,
  });
}

export type MacPackageMetadataObservation = Readonly<{
  distributionRequireScripts: string;
  distributionProductId: string;
  distributionProductVersion: string;
  distributionInstallLocation: string;
  distributionPackageReferenceCount: number;
  distributionMatchingPackageReferenceCount: number;
  distributionPayloadPackageReferenceCount: number;
  distributionChoiceCount: number;
  distributionMatchingInstallChoiceCount: number;
  distributionMatchingDefaultChoiceCount: number;
  distributionBundlePath: string;
  distributionBundleId: string;
  distributionBundleProductVersion: string;
  distributionBundleBuildNumber: string;
  distributionUnexpectedElementCount: number;
  distributionScriptConstructCount: number;
  distributionUnexpectedInstallChoiceAttributeCount: number;
  packageInfoIdentifier: string;
  packageInfoVersion: string;
  packageInfoInstallLocation: string;
  packageInfoRelocatable: string;
  packageInfoPostinstallAction: string;
  packageInfoPayloadCount: number;
  packageInfoNumberOfFiles: string;
  packageInfoUnexpectedPayloadAttributeCount: number;
  packageInfoBundleCount: number;
  packageInfoBundlePath: string;
  packageInfoBundleId: string;
  packageInfoBundleProductVersion: string;
  packageInfoBundleBuildNumber: string;
  packageInfoUnexpectedElementCount: number;
  packageInfoScriptConstructCount: number;
  packageInfoUnexpectedRootAttributeCount: number;
}>;

export function validateMacPackageMetadata(
  observation: MacPackageMetadataObservation,
  expectedProductVersion: string,
  expectedBuildNumber: string,
) {
  const packageInfoNumberOfFiles = /^(?:0|[1-9]\d*)$/u.test(observation.packageInfoNumberOfFiles)
    ? Number(observation.packageInfoNumberOfFiles)
    : Number.NaN;
  if (!Number.isSafeInteger(packageInfoNumberOfFiles) || packageInfoNumberOfFiles < 1
    || observation.distributionRequireScripts !== "false"
    || observation.distributionProductId !== MAC_APP_STORE_BUNDLE_ID
    || observation.distributionProductVersion !== expectedProductVersion
    || observation.distributionInstallLocation !== "/Applications"
    || observation.distributionPackageReferenceCount !== 2
    || observation.distributionMatchingPackageReferenceCount !== 2
    || observation.distributionPayloadPackageReferenceCount !== 1
    || observation.distributionChoiceCount !== 2
    || observation.distributionMatchingInstallChoiceCount !== 1
    || observation.distributionMatchingDefaultChoiceCount !== 1
    || observation.distributionBundlePath !== "RangaBot.app"
    || observation.distributionBundleId !== MAC_APP_STORE_BUNDLE_ID
    || observation.distributionBundleProductVersion !== expectedProductVersion
    || observation.distributionBundleBuildNumber !== expectedBuildNumber
    || observation.distributionUnexpectedElementCount !== 0
    || observation.distributionScriptConstructCount !== 0
    || observation.distributionUnexpectedInstallChoiceAttributeCount !== 0
    || observation.packageInfoIdentifier !== MAC_APP_STORE_BUNDLE_ID
    || observation.packageInfoVersion !== expectedProductVersion
    || observation.packageInfoInstallLocation !== "/Applications"
    || observation.packageInfoRelocatable !== "false"
    || observation.packageInfoPostinstallAction !== "none"
    || observation.packageInfoPayloadCount !== 1
    || observation.packageInfoUnexpectedPayloadAttributeCount !== 0
    || observation.packageInfoBundleCount !== 1
    || observation.packageInfoBundlePath !== "./RangaBot.app"
    || observation.packageInfoBundleId !== MAC_APP_STORE_BUNDLE_ID
    || observation.packageInfoBundleProductVersion !== expectedProductVersion
    || observation.packageInfoBundleBuildNumber !== expectedBuildNumber
    || observation.packageInfoUnexpectedElementCount !== 0
    || observation.packageInfoScriptConstructCount !== 0
    || observation.packageInfoUnexpectedRootAttributeCount !== 0) {
    throw new Error("Expanded installer metadata does not describe one script-free exact RangaBot installation in /Applications.");
  }
  return Object.freeze({
    componentIdentifier: MAC_APP_STORE_BUNDLE_ID,
    componentPackage: expandedComponentName,
    installLocation: "/Applications",
    productVersion: expectedProductVersion,
    macBuildNumber: expectedBuildNumber,
    distributionPackageReferences: observation.distributionPackageReferenceCount,
    packageInfoNumberOfFiles,
    installerScriptsFound: 0,
  });
}

type MacPackageEntryType = "directory" | "file" | "symlink";

type MacPackageBomEntry = Readonly<{
  path: string;
  mode: number;
  type: MacPackageEntryType;
}>;

type MacPackagePayloadEntry = Readonly<{
  path: string;
  type: MacPackageEntryType;
  linkTarget: string | null;
}>;

function macPackageEntryType(mode: number, path: string): MacPackageEntryType {
  if (mode === 0 && path === ".") return "directory";
  switch (mode & 0o170000) {
    case 0o040000: return "directory";
    case 0o100000: return "file";
    case 0o120000: return "symlink";
    default: throw new Error("Expanded installer BOM contains an unsupported filesystem entry type.");
  }
}

function validateBomPath(path: string) {
  if (!path || Buffer.byteLength(path, "utf8") > 4096
    || /[\u0000-\u001f\u007f\\]/u.test(path)) {
    throw new Error("Expanded installer BOM contains an invalid path.");
  }
  if (path === ".") return;
  if (!path.startsWith("./")) throw new Error("Expanded installer BOM contains an invalid path.");
  const parts = path.slice(2).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Expanded installer BOM contains an invalid path component.");
  }
  if (path !== "./RangaBot.app" && path !== "./._RangaBot.app"
    && !path.startsWith("./RangaBot.app/")) {
    throw new Error("Expanded installer BOM contains content outside RangaBot.app.");
  }
}

function parseMacPackageBomEntries(sourceInput: string) {
  const source = sourceInput.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!source || Buffer.byteLength(source, "utf8") > 64 * 1024 * 1024 || source.includes("\0")) {
    throw new Error("Expanded installer BOM listing is invalid.");
  }
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  if (lines.length < 2) throw new Error("Expanded installer BOM contains too few entries.");
  const entries: MacPackageBomEntry[] = lines.map((line) => {
    const match = /^(0|[1-7][0-7]{4,5})\t([^\t]+)$/u.exec(line);
    if (!match) throw new Error("Expanded installer BOM contains an invalid typed entry.");
    const mode = Number.parseInt(match[1], 8);
    const path = match[2];
    validateBomPath(path);
    return Object.freeze({ path, mode, type: macPackageEntryType(mode, path) });
  });
  const unique = new Set(entries.map((entry) => entry.path));
  if (unique.size !== entries.length || !unique.has(".") || !unique.has("./RangaBot.app")) {
    throw new Error("Expanded installer BOM does not contain one unique RangaBot payload root.");
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (byPath.get(".")?.type !== "directory"
    || byPath.get("./RangaBot.app")?.type !== "directory") {
    throw new Error("Expanded installer BOM payload roots are not directories.");
  }
  return Object.freeze(entries.sort((left, right) => bytewiseCompare(left.path, right.path)));
}

function safeRelativePath(root: string, candidate: string) {
  const value = relative(root, candidate);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith("../"));
}

function inspectMacPackagePayload(payloadPathInput: string) {
  const payloadCandidate = resolve(payloadPathInput);
  const payloadStatus = lstatSync(payloadCandidate);
  if (payloadStatus.isSymbolicLink() || !payloadStatus.isDirectory()) {
    throw new Error("Expanded installer payload must be one real directory.");
  }
  const payloadPath = realpathSync(payloadCandidate);
  exactDirectoryEntries(payloadPath, ["RangaBot.app"], "Expanded installer payload");
  const appPath = join(payloadPath, "RangaBot.app");
  const entries: MacPackagePayloadEntry[] = [];

  function visit(path: string, bomPath: string) {
    const status = lstatSync(path);
    let type: MacPackageEntryType;
    let linkTarget: string | null = null;
    if (status.isDirectory()) {
      type = "directory";
    } else if (status.isFile()) {
      if (status.nlink !== 1) throw new Error("Expanded installer payload contains a hardlinked file.");
      type = "file";
    } else if (status.isSymbolicLink()) {
      if (status.nlink !== 1) throw new Error("Expanded installer payload contains a hardlinked symbolic link.");
      type = "symlink";
      linkTarget = readlinkSync(path, "utf8");
      if (!linkTarget || isAbsolute(linkTarget) || Buffer.byteLength(linkTarget, "utf8") > 4096
        || /[\u0000-\u001f\u007f\\]/u.test(linkTarget)) {
        throw new Error("Expanded installer payload contains an unsafe symbolic link.");
      }
      const lexicalTarget = resolve(dirname(path), linkTarget);
      if (!safeRelativePath(appPath, lexicalTarget)
        || !safeRelativePath(appPath, realpathSync(path))) {
        throw new Error("Expanded installer payload symbolic link escapes RangaBot.app.");
      }
    } else {
      throw new Error("Expanded installer payload contains an unsupported filesystem entry type.");
    }
    entries.push(Object.freeze({ path: bomPath, type, linkTarget }));
    if (type !== "directory") return;
    for (const name of readdirSync(path).sort(bytewiseCompare)) {
      if (!name || name === "." || name === ".." || Buffer.byteLength(name, "utf8") > 255
        || /[\u0000-\u001f\u007f\\/]/u.test(name)) {
        throw new Error("Expanded installer payload contains an unsafe path component.");
      }
      const childBomPath = bomPath === "." ? `./${name}` : `${bomPath}/${name}`;
      visit(join(path, name), childBomPath);
    }
  }

  visit(payloadPath, ".");
  return Object.freeze(entries);
}

function appleDoubleTarget(path: string) {
  const separator = path.lastIndexOf("/");
  const name = path.slice(separator + 1);
  if (!name.startsWith("._") || name.length === 2) return null;
  return `${path.slice(0, separator + 1)}${name.slice(2)}`;
}

export function validateMacPackageBomEntries(sourceInput: string) {
  const entries = parseMacPackageBomEntries(sourceInput);
  return Object.freeze({ entries: entries.length, payloadRoot: "./RangaBot.app" as const });
}

export function reconcileMacPackageBomWithPayload(
  sourceInput: string,
  payloadPathInput: string,
  packageInfoNumberOfFiles: number,
) {
  const bomEntries = parseMacPackageBomEntries(sourceInput);
  const payloadEntries = inspectMacPackagePayload(payloadPathInput);
  if (!Number.isSafeInteger(packageInfoNumberOfFiles) || packageInfoNumberOfFiles < 1
    || packageInfoNumberOfFiles !== payloadEntries.length - 1) {
    throw new Error("PackageInfo numberOfFiles does not match the exact payload entry count excluding its root.");
  }
  const bomByPath = new Map(bomEntries.map((entry) => [entry.path, entry]));
  const payloadByPath = new Map(payloadEntries.map((entry) => [entry.path, entry]));
  let metadataEntries = 0;
  for (const payloadEntry of payloadEntries) {
    const bomEntry = bomByPath.get(payloadEntry.path);
    if (!bomEntry || bomEntry.type !== payloadEntry.type) {
      throw new Error("Expanded installer BOM is missing or mistypes a payload entry.");
    }
  }
  for (const bomEntry of bomEntries) {
    if (payloadByPath.has(bomEntry.path)) continue;
    const targetPath = appleDoubleTarget(bomEntry.path);
    const payloadTarget = targetPath ? payloadByPath.get(targetPath) : undefined;
    const bomTarget = targetPath ? bomByPath.get(targetPath) : undefined;
    if (!payloadTarget || !bomTarget || bomEntry.type !== payloadTarget.type
      || bomTarget.type !== payloadTarget.type) {
      throw new Error("Expanded installer BOM contains a phantom payload entry.");
    }
    metadataEntries += 1;
  }
  const bomInventorySha256 = createHash("sha256")
    .update(bomEntries.map((entry) => `${entry.mode.toString(8)}\t${entry.path}\n`).join(""), "utf8")
    .digest("hex");
  const payloadInventorySha256 = createHash("sha256")
    .update(payloadEntries.map((entry) => (
      `${entry.type}\t${entry.path}\t${entry.linkTarget ?? ""}\n`
    )).join(""), "utf8")
    .digest("hex");
  return Object.freeze({
    entries: bomEntries.length,
    payloadEntries: payloadEntries.length,
    metadataEntries,
    payloadRoot: "./RangaBot.app" as const,
    bomInventorySha256,
    payloadInventorySha256,
  });
}

export type MacApplicationSignature = Readonly<{
  identity: string;
  teamId: string;
  identifier: typeof MAC_APP_STORE_BUNDLE_ID;
  timestamp: string | null;
}>;

export function parseMacApplicationSignature(
  sourceInput: string,
  expectedIdentityInput: string,
  expectedTeamIdInput: string,
): MacApplicationSignature {
  const source = sourceInput.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!source || Buffer.byteLength(source, "utf8") > 1024 * 1024 || source.includes("\0") || /(?:^|\n)Signature=adhoc(?:\n|$)/u.test(source)) {
    throw new Error("Application signature details are invalid or ad hoc.");
  }
  const expectedIdentity = exactSingleLine(expectedIdentityInput, "Expected application signing identity");
  const expectedTeamId = exactSingleLine(expectedTeamIdInput, "Expected Apple Team ID", 10);
  if (!teamIdPattern.test(expectedTeamId)) throw new Error("Expected Apple Team ID is invalid.");
  const identifiers = exactMatches(source, /^Identifier=(.+?)$/gmu);
  const teams = exactMatches(source, /^TeamIdentifier=(.+?)$/gmu);
  const authorities = exactMatches(source, /^Authority=(.+?)$/gmu);
  const timestamps = exactMatches(source, /^Timestamp=(.+?)$/gmu);
  if (identifiers.length !== 1 || identifiers[0][1] !== MAC_APP_STORE_BUNDLE_ID
    || teams.length !== 1 || teams[0][1] !== expectedTeamId
    || authorities.length < 3 || authorities[0][1] !== expectedIdentity
    || !authorities.some((match) => match[1] === "Apple Root CA")
    || timestamps.length > 1) {
    throw new Error("Application signature identity does not match the exact RangaBot distribution identity.");
  }
  return Object.freeze({
    identity: expectedIdentity,
    teamId: expectedTeamId,
    identifier: MAC_APP_STORE_BUNDLE_ID,
    timestamp: timestamps[0]?.[1] ?? null,
  });
}

export function assertMacAppStoreEntitlements(sourceInput: string) {
  const source = sourceInput.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!source || Buffer.byteLength(source, "utf8") > 1024 * 1024 || source.includes("\0")) {
    throw new Error("Application entitlements are invalid.");
  }
  for (const key of [
    "com.apple.security.app-sandbox",
    "com.apple.security.files.bookmarks.app-scope",
    "com.apple.security.files.user-selected.read-write",
    "com.apple.security.network.client",
    "com.apple.security.network.server",
  ]) {
    if (!new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true\\s*/>`, "u").test(source)) {
      throw new Error(`Application is missing required Mac App Store entitlement ${key}.`);
    }
  }
  if (/<key>get-task-allow<\/key>\s*<true\s*\/>/u.test(source)
    || /<key>com\.apple\.security\.inherit<\/key>\s*<true\s*\/>/u.test(source)) {
    throw new Error("Outer Mac App Store application contains a development-only entitlement.");
  }
}

export type MacProvisioningProfile = Readonly<{
  name: string;
  uuid: string;
  teamId: string;
  applicationIdentifier: string;
  platform: "OSX";
  expiresAt: string;
  sha256: string;
}>;

export function validateMacProvisioningProfile(input: Readonly<{
  name: string;
  uuid: string;
  teamId: string;
  applicationIdentifier: string;
  platform: string;
  expiresAt: string;
  sha256: string;
  hasAdditionalTeamIdentifier: boolean;
  hasAdditionalPlatform: boolean;
  hasProvisionedDevices: boolean;
  getTaskAllow: boolean | null;
}>, expectedTeamId: string): MacProvisioningProfile {
  const teamId = exactSingleLine(expectedTeamId, "Expected Apple Team ID", 10);
  if (!teamIdPattern.test(teamId) || input.teamId !== teamId || input.hasAdditionalTeamIdentifier
    || input.platform !== "OSX" || input.hasAdditionalPlatform || input.hasProvisionedDevices
    || input.applicationIdentifier !== `${teamId}.${MAC_APP_STORE_BUNDLE_ID}`
    || input.getTaskAllow === true || !uuidPattern.test(input.uuid)
    || !certificateFingerprintPattern.test(input.sha256)) {
    throw new Error("Embedded provisioning profile does not match the exact RangaBot App Store distribution profile.");
  }
  const name = exactSingleLine(input.name, "Provisioning profile name");
  const expiresAt = exactSingleLine(input.expiresAt, "Provisioning profile expiration");
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("Embedded provisioning profile is expired or invalid.");
  return Object.freeze({
    name,
    uuid: input.uuid.toLowerCase(),
    teamId,
    applicationIdentifier: input.applicationIdentifier,
    platform: "OSX",
    expiresAt,
    sha256: input.sha256,
  });
}

export function assertMacPackageProductIdentity(input: Readonly<{
  bundleIdentifier: string;
  marketingVersion: string;
  buildNumber: string;
  expectedProductVersion: string;
  expectedBuildNumber: string;
}>) {
  if (input.bundleIdentifier !== MAC_APP_STORE_BUNDLE_ID
    || input.marketingVersion !== input.expectedProductVersion
    || input.buildNumber !== input.expectedBuildNumber) {
    throw new Error("Expanded application product identity does not match its bound manifest.");
  }
}
