import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
const plist = require("plist") as {
  parse(value: string): unknown;
  build(value: Record<string, unknown>): string;
};

export const MAC_APP_STORE_BUNDLE_ID = "com.rangabot.desktop";

export type MacAppStoreSignatureMode = "app-store-development" | "app-store-distribution";

export type MacSigningCertificate = Readonly<{
  sha1: string;
  derBase64: string;
  commonName: string;
  organizationalUnit: string;
  issuerCommonName: string;
  validFrom: Date;
  validTo: Date;
}>;

export type ValidatedMacAppStoreProfile = Readonly<{
  applicationIdentifier: string;
  certificate: MacSigningCertificate;
  profile: Record<string, unknown>;
}>;

export type MacCodeSignatureInspection = Readonly<{
  path: string;
  identifier: string;
  teamIdentifier: string;
  authorities: readonly string[];
  leafCertificateSha1: string;
  entitlements: Record<string, unknown>;
}>;

const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

// Apple Root CA, intentionally pinned so an otherwise well-formed CMS signed
// by an arbitrary root cannot be treated as an Apple provisioning profile.
const APPLE_PROVISIONING_ROOT_SHA256 = new Set([
  "B0B1730ECBC7FF4505142C49F1295E6EDA6BCAED7E2C68C5BE91B5A11001F024",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a dictionary.`);
  }
  return value as Record<string, unknown>;
}

function exactSingletonStringArray(value: unknown, expected: string, label: string) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) {
    throw new Error(`${label} must contain exactly ${expected}.`);
  }
}

function dateValue(value: unknown, label: string) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(typeof value === "string" ? value : Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error(`${label} must be a valid date.`);
  return result;
}

function certificateData(value: unknown) {
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  throw new Error("Provisioning profile DeveloperCertificates contains invalid certificate data.");
}

function distinguishedNameValue(value: string, key: string) {
  const line = value.split(/\n/).find((entry) => entry.startsWith(`${key}=`));
  if (line) return line.slice(key.length + 1);
  const slash = value.split("/").find((entry) => entry.startsWith(`${key}=`));
  return slash?.slice(key.length + 1) ?? "";
}

function normalizedSha1(value: string) {
  return value.replaceAll(":", "").toUpperCase();
}

function certificateFromX509(certificate: X509Certificate): MacSigningCertificate {
  const commonName = distinguishedNameValue(certificate.subject, "CN");
  const organizationalUnit = distinguishedNameValue(certificate.subject, "OU");
  const issuerCommonName = distinguishedNameValue(certificate.issuer, "CN");
  if (!commonName || !organizationalUnit || !issuerCommonName) {
    throw new Error("The selected signing certificate has incomplete subject or issuer metadata.");
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

export function parsePlistDictionary(value: string, label = "Property list") {
  return record(plist.parse(value), label);
}

export function buildPlistDictionary(value: Record<string, unknown>) {
  return plist.build(value);
}

function assertCertificateCurrentlyValid(certificate: X509Certificate, now: number, label: string) {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo <= now) {
    throw new Error(`${label} is not currently valid.`);
  }
}

function assertTrustedAppleProvisioningProfileCms(profileBytes: Buffer) {
  const certificatesResult = spawnSync("/usr/bin/openssl", [
    "pkcs7", "-inform", "der", "-print_certs",
  ], {
    input: profileBytes,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (certificatesResult.error) throw certificatesResult.error;
  if (certificatesResult.status !== 0 || certificatesResult.signal) {
    throw new Error("The provisioning profile certificate chain could not be inspected.");
  }
  const certificatePems = certificatesResult.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const certificates = certificatePems.map((pem) => new X509Certificate(pem));
  const roots = certificates.filter((certificate) => (
    certificate.subject === certificate.issuer
    && APPLE_PROVISIONING_ROOT_SHA256.has(normalizedSha1(certificate.fingerprint256))
  ));
  if (roots.length !== 1 || !roots[0].verify(roots[0].publicKey)) {
    throw new Error("The provisioning profile is not rooted in the pinned Apple provisioning authority.");
  }
  const signers = certificates.filter((certificate) => distinguishedNameValue(certificate.subject, "CN") === "Mac OS X Provisioning Profile Signing");
  if (signers.length !== 1) throw new Error("The provisioning profile has an invalid Apple profile-signing certificate.");
  const signer = signers[0];
  const intermediates = certificates.filter((certificate) => certificate.subject === signer.issuer);
  if (intermediates.length !== 1 || intermediates[0].issuer !== roots[0].subject
    || !signer.verify(intermediates[0].publicKey) || !intermediates[0].verify(roots[0].publicKey)) {
    throw new Error("The provisioning profile Apple certificate chain is invalid.");
  }
  const now = Date.now();
  assertCertificateCurrentlyValid(roots[0], now, "Apple provisioning root certificate");
  assertCertificateCurrentlyValid(intermediates[0], now, "Apple provisioning intermediate certificate");
  assertCertificateCurrentlyValid(signer, now, "Apple provisioning signer certificate");

  const cmsResult = spawnSync("/usr/bin/openssl", ["cms", "-inform", "der", "-cmsout", "-print"], {
    input: profileBytes,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (cmsResult.error) throw cmsResult.error;
  const signerSection = cmsResult.stdout.slice(cmsResult.stdout.indexOf("signerInfos:"));
  const signerSerial = /serialNumber:\s*(?:0x([A-Fa-f0-9]+)|(\d+))/.exec(signerSection);
  const signerIssuer = /issuer:\s*([^\r\n]+)/.exec(signerSection)?.[1] ?? "";
  if (cmsResult.status !== 0 || cmsResult.signal || !signerSerial || !signerIssuer.includes("Apple Worldwide Developer Relations Certification Authority")) {
    throw new Error("The provisioning profile CMS signer identity is invalid.");
  }
  const cmsSerial = signerSerial[1]
    ? BigInt(`0x${signerSerial[1]}`).toString(16).toUpperCase()
    : BigInt(signerSerial[2]).toString(16).toUpperCase();
  const certificateSerial = BigInt(`0x${signer.serialNumber}`).toString(16).toUpperCase();
  if (cmsSerial !== certificateSerial) throw new Error("The provisioning profile CMS was not signed by the Apple profile-signing certificate.");
}

export function decodeProvisioningProfileBytes(profileBytes: Buffer) {
  if (profileBytes.length < 1_024 || profileBytes.length > 1024 * 1024) {
    throw new Error("The Mac App Store provisioning profile has an invalid size.");
  }
  assertTrustedAppleProvisioningProfileCms(profileBytes);
  const result = spawnSync("/usr/bin/openssl", [
    "smime",
    "-inform", "der",
    "-verify",
    "-noverify",
  ], {
    input: profileBytes,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal || !result.stdout) {
    throw new Error("The Mac App Store provisioning profile CMS signature could not be verified and decoded.");
  }
  return parsePlistDictionary(result.stdout, "Provisioning profile");
}

export function decodeProvisioningProfile(profilePath: string) {
  return decodeProvisioningProfileBytes(readFileSync(profilePath));
}

function validCodeSigningIdentities() {
  const output = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const identities: Array<{ sha1: string; name: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(.*)"\s*$/.exec(line);
    if (match) identities.push({ sha1: match[1].toUpperCase(), name: match[2] });
  }
  return identities;
}

export function resolveMacSigningCertificate(identity: string) {
  const identitySha1 = normalizedSha1(identity);
  const fingerprintInput = /^[A-F0-9]{40}$/.test(identitySha1);
  const matches = validCodeSigningIdentities().filter((candidate) => (
    fingerprintInput ? candidate.sha1 === identitySha1 : candidate.name === identity
  ));
  if (matches.length !== 1) {
    throw new Error("The Mac App Store signing identity must resolve to exactly one valid certificate/private-key identity.");
  }

  const pemOutput = execFileSync("/usr/bin/security", ["find-certificate", "-a", "-p"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const certificates = pemOutput.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const selected = certificates
    .map((pem) => certificateFromX509(new X509Certificate(pem)))
    .filter((certificate) => certificate.sha1 === matches[0].sha1);
  if (selected.length !== 1 || selected[0].commonName !== matches[0].name) {
    throw new Error("The selected signing identity certificate could not be resolved unambiguously from the Keychain.");
  }
  return selected[0];
}

export function validateMacAppStoreProvisioningProfile(input: Readonly<{
  profile: Record<string, unknown>;
  certificate: MacSigningCertificate;
  mode: MacAppStoreSignatureMode;
  teamId: string;
  bundleId?: string;
  now?: Date;
}>): ValidatedMacAppStoreProfile {
  const { profile, certificate, mode, teamId } = input;
  const bundleId = input.bundleId ?? MAC_APP_STORE_BUNDLE_ID;
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("The profile validation time is invalid.");

  const platforms = profile.Platform;
  if (!Array.isArray(platforms) || platforms.length !== 1 || (platforms[0] !== "OSX" && platforms[0] !== "macOS")) {
    throw new Error("The provisioning profile must target macOS only.");
  }
  exactSingletonStringArray(profile.TeamIdentifier, teamId, "Provisioning profile TeamIdentifier");
  exactSingletonStringArray(profile.ApplicationIdentifierPrefix, teamId, "Provisioning profile ApplicationIdentifierPrefix");

  const entitlements = record(profile.Entitlements, "Provisioning profile Entitlements");
  const applicationIdentifier = `${teamId}.${bundleId}`;
  if (entitlements["com.apple.application-identifier"] !== applicationIdentifier
    || entitlements["com.apple.developer.team-identifier"] !== teamId) {
    throw new Error("The provisioning profile application identifier, bundle, or team does not match RangaBot.");
  }
  const keychainGroups = entitlements["keychain-access-groups"];
  if (keychainGroups !== undefined && (!Array.isArray(keychainGroups) || keychainGroups.length === 0
    || keychainGroups.some((group) => group !== `${teamId}.*` && group !== applicationIdentifier))) {
    throw new Error("The provisioning profile contains a keychain group outside the exact RangaBot team/application scope.");
  }

  const creation = dateValue(profile.CreationDate, "Provisioning profile CreationDate");
  const expiration = dateValue(profile.ExpirationDate, "Provisioning profile ExpirationDate");
  if (creation.getTime() > now.getTime() || expiration.getTime() <= now.getTime() || expiration.getTime() <= creation.getTime()) {
    throw new Error("The provisioning profile is not currently valid.");
  }

  const profileEntitlements = entitlements;
  const hasDevices = Object.hasOwn(profile, "ProvisionedDevices");
  const devices = profile.ProvisionedDevices;
  if (mode === "app-store-development") {
    if (!hasDevices || !Array.isArray(devices) || devices.length === 0 || profileEntitlements["get-task-allow"] !== true
      || profile.ProvisionsAllDevices === true) {
      throw new Error("The provisioning profile is not a Mac App Store development profile.");
    }
  } else if (hasDevices || profileEntitlements["get-task-allow"] === true || profile.ProvisionsAllDevices === true) {
    throw new Error("The provisioning profile is not a Mac App Store distribution profile.");
  }

  const allowedCommonName = mode === "app-store-development"
    ? /^(?:Apple Development|Mac Developer): /
    : /^(?:Apple Distribution|3rd Party Mac Developer Application): /;
  if (!allowedCommonName.test(certificate.commonName)
    || certificate.organizationalUnit !== teamId
    || !/^Apple Worldwide Developer Relations Certification Authority(?: G\d+)?$/.test(certificate.issuerCommonName)) {
    throw new Error("The signing certificate type, team, or Apple issuer does not match the requested Mac App Store mode.");
  }
  if (!Number.isFinite(certificate.validFrom.getTime()) || !Number.isFinite(certificate.validTo.getTime())
    || certificate.validFrom.getTime() > now.getTime() || certificate.validTo.getTime() <= now.getTime()
    || expiration.getTime() > certificate.validTo.getTime()) {
    throw new Error("The selected signing certificate does not cover the provisioning profile validity window.");
  }

  const developerCertificates = profile.DeveloperCertificates;
  if (!Array.isArray(developerCertificates) || developerCertificates.length === 0
    || !developerCertificates.map(certificateData).includes(certificate.derBase64)) {
    throw new Error("The selected signing certificate is not embedded in the provisioning profile.");
  }

  return Object.freeze({ applicationIdentifier, certificate, profile });
}

export function expectedMacAppStoreMainEntitlements(
  base: Record<string, unknown>,
  validatedProfile: ValidatedMacAppStoreProfile,
  teamId: string,
) {
  const requiredBaseKeys = [
    "com.apple.security.app-sandbox",
    "com.apple.security.files.bookmarks.app-scope",
    "com.apple.security.files.user-selected.read-write",
    "com.apple.security.network.client",
    "com.apple.security.network.server",
  ];
  const actualKeys = Object.keys(base).sort();
  if (actualKeys.length !== requiredBaseKeys.length
    || requiredBaseKeys.sort().some((key, index) => actualKeys[index] !== key || base[key] !== true)) {
    throw new Error("The Mac App Store main entitlement template must contain exactly the approved sandbox, file, and network capabilities.");
  }
  return Object.freeze({
    ...base,
    "com.apple.application-identifier": validatedProfile.applicationIdentifier,
    "com.apple.developer.team-identifier": teamId,
  });
}

export function expectedMacAppStoreChildEntitlements(base: Record<string, unknown>) {
  const required = ["com.apple.security.app-sandbox", "com.apple.security.inherit"].sort();
  const actual = Object.keys(base).sort();
  if (actual.length !== required.length
    || required.some((key, index) => actual[index] !== key || base[key] !== true)) {
    throw new Error("The Mac App Store child entitlement template must contain exactly sandbox and inherit.");
  }
  return Object.freeze({ ...base });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function samePlist(left: Record<string, unknown>, right: Record<string, unknown>) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function assertExactPlistDictionary(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  if (!samePlist(actual, expected)) throw new Error(`${label} does not exactly match the approved policy.`);
}

export function assertMacAppStoreCodeSignatureInspections(input: Readonly<{
  inspections: readonly MacCodeSignatureInspection[];
  mainPaths: ReadonlySet<string>;
  teamId: string;
  leafAuthority: string;
  leafCertificateSha1: string;
  issuerAuthority: string;
  mainEntitlements: Record<string, unknown>;
  childEntitlements: Record<string, unknown>;
  bundleId?: string;
}>) {
  if (input.inspections.length < input.mainPaths.size || input.mainPaths.size === 0) {
    throw new Error("The Mac App Store code-signature inventory is incomplete.");
  }
  const paths = new Set<string>();
  const outer = input.inspections.find((entry) => input.mainPaths.has(entry.path));
  if (!outer || outer.authorities.length < 3
    || outer.authorities[0] !== input.leafAuthority
    || !outer.authorities.includes(input.issuerAuthority)
    || !/^Apple Root CA(?: - G\d+)?$/.test(outer.authorities.at(-1) ?? "")) {
    throw new Error("The outer Mac App Store signature does not have the exact selected Apple authority chain.");
  }
  for (const inspection of input.inspections) {
    if (paths.has(inspection.path) || !inspection.identifier) {
      throw new Error("The Mac App Store code-signature inventory contains a duplicate or unidentified code object.");
    }
    paths.add(inspection.path);
    if (input.mainPaths.has(inspection.path) && inspection.identifier !== (input.bundleId ?? MAC_APP_STORE_BUNDLE_ID)) {
      throw new Error(`The main signed code has the wrong bundle identifier: ${inspection.path}.`);
    }
    if (inspection.teamIdentifier !== input.teamId
      || normalizedSha1(inspection.leafCertificateSha1) !== normalizedSha1(input.leafCertificateSha1)
      || inspection.authorities.length !== outer.authorities.length
      || inspection.authorities.some((authority, index) => authority !== outer.authorities[index])) {
      throw new Error(`Signed code has a mismatched team, authority chain, or leaf certificate: ${inspection.path}.`);
    }
    const expectedEntitlements = input.mainPaths.has(inspection.path) ? input.mainEntitlements : input.childEntitlements;
    if (!samePlist(inspection.entitlements, expectedEntitlements)) {
      throw new Error(`Signed code has unexpected or missing entitlements: ${inspection.path}.`);
    }
  }
  for (const mainPath of input.mainPaths) {
    if (!paths.has(mainPath)) throw new Error(`The Mac App Store main code object was not inspected: ${mainPath}.`);
  }
}

export function isMachOFile(path: string) {
  const descriptor = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    if (readSync(descriptor, magic, 0, magic.length, 0) !== magic.length) return false;
    return MACH_O_MAGICS.has(magic.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

export function collectMachOFiles(root: string) {
  const absoluteRoot = resolve(root);
  const files: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) continue;
      if (status.isDirectory()) visit(path);
      else if (status.isFile() && isMachOFile(path)) files.push(path);
    }
  }
  visit(absoluteRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function codesignOutput(path: string) {
  const result = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", path], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error(`Code-signature details could not be read: ${path}.`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function detailValues(output: string, key: string) {
  return output.split(/\r?\n/)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

function extractAndAssertLeafSigningCertificate(path: string, expectedCertificate: MacSigningCertificate) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "rangabot-codesign-cert-"));
  chmodSync(temporaryRoot, 0o700);
  try {
    const certificatePrefix = join(temporaryRoot, "certificate-");
    const extract = spawnSync("/usr/bin/codesign", [
      "--display",
      `--extract-certificates=${certificatePrefix}`,
      path,
    ], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (extract.error) throw extract.error;
    if (extract.status !== 0 || extract.signal) {
      throw new Error(`The leaf signing certificate could not be extracted: ${path}.`);
    }
    const leafPath = `${certificatePrefix}0`;
    const leafStatus = lstatSync(leafPath);
    if (leafStatus.isSymbolicLink() || !leafStatus.isFile() || leafStatus.size < 256 || leafStatus.size > 64 * 1024) {
      throw new Error(`The extracted leaf signing certificate is invalid: ${path}.`);
    }
    const leaf = new X509Certificate(readFileSync(leafPath));
    const leafSha1 = normalizedSha1(leaf.fingerprint);
    const expectedSha1 = normalizedSha1(expectedCertificate.sha1);
    const expectedDer = Buffer.from(expectedCertificate.derBase64, "base64");
    if (leafSha1 !== expectedSha1 || !leaf.raw.equals(expectedDer)) {
      throw new Error(`Signed code does not use the exact provisioning-profile certificate: ${path}.`);
    }
    return leafSha1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function inspectMacCodeSignature(
  path: string,
  expectedCertificate: MacSigningCertificate,
): MacCodeSignatureInspection {
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (verify.error) throw verify.error;
  if (verify.status !== 0 || verify.signal) throw new Error(`Nested signed code failed strict verification: ${path}.`);
  const details = codesignOutput(path);
  if (/(?:^|\n)Signature=adhoc(?:\n|$)/.test(details)) throw new Error(`Nested signed code is ad-hoc: ${path}.`);
  const identifier = detailValues(details, "Identifier");
  const teamIdentifier = detailValues(details, "TeamIdentifier");
  const authorities = detailValues(details, "Authority");
  if (identifier.length !== 1 || teamIdentifier.length !== 1 || authorities.length === 0) {
    throw new Error(`Nested signed code has incomplete signature metadata: ${path}.`);
  }
  const leafCertificateSha1 = extractAndAssertLeafSigningCertificate(path, expectedCertificate);

  const entitlementsResult = spawnSync("/usr/bin/codesign", ["--display", "--entitlements", ":-", path], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const entitlementsOutput = `${entitlementsResult.stdout ?? ""}\n${entitlementsResult.stderr ?? ""}`;
  const xmlStart = entitlementsOutput.indexOf("<?xml");
  if (entitlementsResult.error) throw entitlementsResult.error;
  if (entitlementsResult.status !== 0 || entitlementsResult.signal || xmlStart < 0) {
    throw new Error(`Nested signed code entitlements could not be read: ${path}.`);
  }
  return Object.freeze({
    path,
    identifier: identifier[0],
    teamIdentifier: teamIdentifier[0],
    authorities,
    leafCertificateSha1,
    entitlements: parsePlistDictionary(entitlementsOutput.slice(xmlStart), "Code-signature entitlements"),
  });
}

export function verifyCompleteMacAppStoreCodeSignature(input: Readonly<{
  appPath: string;
  mainExecutablePath: string;
  teamId: string;
  certificate: MacSigningCertificate;
  mainEntitlements: Record<string, unknown>;
  childEntitlements: Record<string, unknown>;
}>) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", input.appPath], { stdio: "inherit" });
  const nativePaths = collectMachOFiles(input.appPath);
  if (!nativePaths.includes(input.mainExecutablePath)) {
    throw new Error("The main Mac App Store executable is missing from the native-code inventory.");
  }
  const relativeNativePaths = new Set(nativePaths.map((path) => relative(input.appPath, path).split(sep).join("/")));
  for (const required of [
    "Contents/Resources/rangabot-resources/runtime/ollama/ollama",
    "Contents/Resources/rangabot-resources/runtime/ollama/llama-server",
    "Contents/Resources/rangabot-resources/runtime/ollama/llama-quantize",
  ]) {
    if (!relativeNativePaths.has(required)) throw new Error(`The signed native-code inventory is missing ${required}.`);
  }
  const inspections = [input.appPath, ...nativePaths]
    .map((path) => inspectMacCodeSignature(path, input.certificate));
  assertMacAppStoreCodeSignatureInspections({
    inspections,
    mainPaths: new Set([input.appPath, input.mainExecutablePath]),
    teamId: input.teamId,
    leafAuthority: input.certificate.commonName,
    leafCertificateSha1: input.certificate.sha1,
    issuerAuthority: input.certificate.issuerCommonName,
    mainEntitlements: input.mainEntitlements,
    childEntitlements: input.childEntitlements,
    bundleId: MAC_APP_STORE_BUNDLE_ID,
  });
  return Object.freeze({ inspectedCodeObjects: inspections.length, nativeCodeFiles: nativePaths.length });
}

export function readPlistDictionary(path: string, label: string) {
  return parsePlistDictionary(readFileSync(path, "utf8"), label);
}
