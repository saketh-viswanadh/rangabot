import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectExpandedPackageMetadata } from "../scripts/verify-macos-mas-pkg.ts";
import {
  assertMacAppStoreEntitlements,
  assertMacPackageProductIdentity,
  inspectExpandedMacPackage,
  parseMacApplicationSignature,
  parseMacInstallerSignature,
  reconcileMacPackageBomWithPayload,
  validateMacPackageBomEntries,
  validateMacPackageMetadata,
  validateMacInstallerCertificate,
  validateMacProvisioningProfile,
} from "../lib/macos-mas-pkg.ts";

const teamId = "MZPU6H4D3J";
const installerIdentity = "3rd Party Mac Developer Installer: Saketh Viswanadha";
const applicationIdentity = "Apple Distribution: Saketh Viswanadha";
const installerDerBase64 = Buffer.from("resolved-installer-certificate", "utf8").toString("base64");
const fingerprint = "bdddb61371e6f4c403d3193619bfdf3dfaf0b7c07377278602ba3405b6f30473";
const fingerprintTail = fingerprint.slice(40).match(/../g)?.join(" ") ?? "";
const installerCertificate = {
  sha1: "11".repeat(20).toUpperCase(),
  derBase64: installerDerBase64,
  commonName: installerIdentity,
  organizationalUnit: teamId,
  issuerCommonName: "Apple Worldwide Developer Relations Certification Authority",
  validFrom: new Date("2026-01-01T00:00:00Z"),
  validTo: new Date("2099-08-24T12:00:00Z"),
} as const;

function installerSignature(overrides = "") {
  return `Package "RangaBot.pkg":
   Status: signed by a developer certificate issued by Apple (Development)
   Signed with a trusted timestamp on: 2026-08-24 12:00:00 +0000
   Certificate Chain:
    1. ${installerIdentity}
       Expires: 2099-08-24 12:00:00 +0000
       SHA256 Fingerprint:
         ${fingerprint.slice(0, 40).match(/../g)?.join(" ")}
         ${fingerprint.slice(40).match(/../g)?.join(" ")}
    2. Apple Worldwide Developer Relations Certification Authority
    3. Apple Root CA
${overrides}`;
}

test("installer signature parser binds exact Apple leaf, team, fingerprint, chain, and timestamp", () => {
  const parsed = parseMacInstallerSignature(installerSignature(), installerCertificate, teamId);
  assert.equal(parsed.identity, installerIdentity);
  assert.equal(parsed.teamId, teamId);
  assert.equal(parsed.certificateSha256, fingerprint);
  assert.equal(parsed.trustedTimestamp, "2026-08-24 12:00:00 +0000");
  for (const status of [
    "signed by a developer certificate issued by Apple",
    "signed by a developer certificate issued by Apple (Development)",
    "signed by a developer certificate issued by Apple for distribution",
    "signed by a certificate trusted by Mac OS X",
  ]) {
    assert.doesNotThrow(() => parseMacInstallerSignature(
      installerSignature().replace("signed by a developer certificate issued by Apple (Development)", status),
      installerCertificate,
      teamId,
    ));
  }
  for (const invalid of [
    installerSignature().replace(installerIdentity, "3rd Party Mac Developer Installer: Other"),
    installerSignature().replace("signed by a developer certificate issued by Apple (Development)", "revoked signature"),
    installerSignature().replace("Signed with a trusted timestamp on:", "Timestamp:"),
    installerSignature().replace("Apple Root CA", "Other Root CA"),
    installerSignature().replace("SHA256 Fingerprint:", "SHA1 Fingerprint:"),
  ]) assert.throws(() => parseMacInstallerSignature(invalid, installerCertificate, teamId));
  assert.throws(() => parseMacInstallerSignature(installerSignature(), installerCertificate, "AAAAAAAAAA"));
  assert.throws(() => parseMacInstallerSignature(
    installerSignature().replace(fingerprint.slice(0, 2), "00"),
    installerCertificate,
    teamId,
  ));
  assert.throws(() => parseMacInstallerSignature(
    installerSignature().replace(fingerprintTail, `${fingerprintTail} AA`),
    installerCertificate,
    teamId,
  ));
});

test("installer certificate validation rejects the wrong class, team, issuer, or validity", () => {
  const resolved = validateMacInstallerCertificate(installerCertificate, teamId, new Date("2026-08-24T13:00:00Z"));
  assert.equal(resolved.sha256, fingerprint);
  assert.equal(resolved.organizationalUnit, teamId);
  assert.doesNotThrow(() => validateMacInstallerCertificate({
    ...installerCertificate,
    commonName: "Mac Installer Distribution: Saketh Viswanadha",
  }, teamId, new Date("2026-08-24T13:00:00Z")));
  assert.doesNotThrow(() => parseMacInstallerSignature(
    installerSignature().replace(installerIdentity, "Mac Installer Distribution: Saketh Viswanadha"),
    { ...installerCertificate, commonName: "Mac Installer Distribution: Saketh Viswanadha" },
    teamId,
  ));
  assert.throws(() => validateMacInstallerCertificate({
    ...installerCertificate,
    commonName: "Developer ID Installer: Saketh Viswanadha",
  }, teamId));
  assert.throws(() => validateMacInstallerCertificate({
    ...installerCertificate,
    organizationalUnit: "AAAAAAAAAA",
  }, teamId));
  assert.throws(() => validateMacInstallerCertificate({
    ...installerCertificate,
    issuerCommonName: "Developer ID Certification Authority",
  }, teamId));
  assert.throws(() => validateMacInstallerCertificate({
    ...installerCertificate,
    validTo: new Date("2026-08-24T12:59:59Z"),
  }, teamId, new Date("2026-08-24T13:00:00Z")));
});

test("application signature and entitlements require the exact App Store distribution identity", () => {
  const details = `Identifier=com.rangabot.desktop
Authority=${applicationIdentity}
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
Timestamp=Aug 24, 2026 at 5:30:00 PM
TeamIdentifier=${teamId}
`;
  const parsed = parseMacApplicationSignature(details, applicationIdentity, teamId);
  assert.equal(parsed.identifier, "com.rangabot.desktop");
  assert.equal(parsed.teamId, teamId);
  assert.throws(() => parseMacApplicationSignature(details.replace("com.rangabot.desktop", "example.other"), applicationIdentity, teamId));
  assert.throws(() => parseMacApplicationSignature(details.replace(teamId, "AAAAAAAAAA"), applicationIdentity, teamId));
  assert.throws(() => parseMacApplicationSignature(`${details}Signature=adhoc\n`, applicationIdentity, teamId));

  const entitlements = `<?xml version="1.0"?><plist><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.files.bookmarks.app-scope</key><true/>
<key>com.apple.security.files.user-selected.read-write</key><true/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.network.server</key><true/>
</dict></plist>`;
  assert.doesNotThrow(() => assertMacAppStoreEntitlements(entitlements));
  assert.throws(() => assertMacAppStoreEntitlements(entitlements.replace("com.apple.security.app-sandbox", "removed")));
  assert.throws(() => assertMacAppStoreEntitlements(entitlements.replace("</dict>", "<key>get-task-allow</key><true/></dict>")));
});

function expandedPackageFixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-expanded-pkg-"));
  const componentPath = join(root, "com.rangabot.desktop.pkg");
  const payloadPath = join(componentPath, "Payload");
  const appPath = join(payloadPath, "RangaBot.app");
  writeFileSync(join(root, "Distribution"), "<installer-gui-script/>\n");
  mkdirSync(join(appPath, "Contents", "Frameworks", "RangaBot Helper.app"), { recursive: true });
  writeFileSync(join(componentPath, "Bom"), "synthetic-bom\n");
  writeFileSync(join(componentPath, "PackageInfo"), "<pkg-info/>\n");
  return { root, componentPath, payloadPath, appPath };
}

test("expanded package inspection accepts only the exact one-component script-free container topology", () => {
  const value = expandedPackageFixture();
  try {
    const inspected = inspectExpandedMacPackage(value.root);
    assert.equal(inspected.appPath, realpathSync(value.appPath));
    assert.equal(inspected.componentPath, realpathSync(value.componentPath));
    assert.equal(inspected.payloadPath, realpathSync(value.payloadPath));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("expanded package inspection rejects extra components, scripts, payload roots, files, and symlinks", () => {
  const adversaries: Array<(value: ReturnType<typeof expandedPackageFixture>) => void> = [
    (value) => writeFileSync(join(value.root, "unexpected.txt"), "unexpected\n"),
    (value) => mkdirSync(join(value.root, "other.component.pkg")),
    (value) => mkdirSync(join(value.componentPath, "Scripts")),
    (value) => writeFileSync(join(value.payloadPath, "unexpected.txt"), "unexpected\n"),
    (value) => mkdirSync(join(value.payloadPath, "Other.app")),
    (value) => {
      rmSync(join(value.root, "Distribution"));
      symlinkSync("/dev/null", join(value.root, "Distribution"));
    },
  ];
  for (const mutate of adversaries) {
    const value = expandedPackageFixture();
    try {
      mutate(value);
      assert.throws(() => inspectExpandedMacPackage(value.root), /unexpected|real regular file/iu);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

const packageMetadata = {
  distributionRequireScripts: "false",
  distributionProductId: "com.rangabot.desktop",
  distributionProductVersion: "1.2.0",
  distributionInstallLocation: "/Applications",
  distributionPackageReferenceCount: 2,
  distributionMatchingPackageReferenceCount: 2,
  distributionPayloadPackageReferenceCount: 1,
  distributionChoiceCount: 2,
  distributionMatchingInstallChoiceCount: 1,
  distributionMatchingDefaultChoiceCount: 1,
  distributionBundlePath: "RangaBot.app",
  distributionBundleId: "com.rangabot.desktop",
  distributionBundleProductVersion: "1.2.0",
  distributionBundleBuildNumber: "1.2.0",
  distributionUnexpectedElementCount: 0,
  distributionScriptConstructCount: 0,
  distributionUnexpectedInstallChoiceAttributeCount: 0,
  packageInfoIdentifier: "com.rangabot.desktop",
  packageInfoVersion: "1.2.0",
  packageInfoInstallLocation: "/Applications",
  packageInfoRelocatable: "false",
  packageInfoPostinstallAction: "none",
  packageInfoPayloadCount: 1,
  packageInfoNumberOfFiles: "2",
  packageInfoUnexpectedPayloadAttributeCount: 0,
  packageInfoBundleCount: 1,
  packageInfoBundlePath: "./RangaBot.app",
  packageInfoBundleId: "com.rangabot.desktop",
  packageInfoBundleProductVersion: "1.2.0",
  packageInfoBundleBuildNumber: "1.2.0",
  packageInfoUnexpectedElementCount: 0,
  packageInfoScriptConstructCount: 0,
  packageInfoUnexpectedRootAttributeCount: 0,
} as const;

test("expanded package metadata binds exact no-script /Applications product and build identity", () => {
  const inspected = validateMacPackageMetadata(packageMetadata, "1.2.0", "1.2.0");
  assert.equal(inspected.componentPackage, "com.rangabot.desktop.pkg");
  assert.equal(inspected.installerScriptsFound, 0);
  for (const invalid of [
    { ...packageMetadata, distributionRequireScripts: "true" },
    { ...packageMetadata, distributionInstallLocation: "/tmp" },
    { ...packageMetadata, distributionScriptConstructCount: 1 },
    { ...packageMetadata, distributionMatchingDefaultChoiceCount: 0 },
    { ...packageMetadata, distributionBundleBuildNumber: "999" },
    { ...packageMetadata, packageInfoInstallLocation: "/Users/Shared" },
    { ...packageMetadata, packageInfoPostinstallAction: "restart" },
    { ...packageMetadata, packageInfoNumberOfFiles: "03" },
    { ...packageMetadata, packageInfoUnexpectedPayloadAttributeCount: 1 },
    { ...packageMetadata, packageInfoScriptConstructCount: 1 },
    { ...packageMetadata, packageInfoUnexpectedElementCount: 1 },
  ]) assert.throws(() => validateMacPackageMetadata(invalid, "1.2.0", "1.2.0"), /script-free exact RangaBot/u);
});

test("expanded package XML inspection rejects active constructs and destination tampering", {
  skip: process.platform !== "darwin" && "requires the macOS xmllint verifier dependency",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-pkg-xml-"));
  const distributionPath = join(root, "Distribution");
  const packageInfoPath = join(root, "PackageInfo");
  const distribution = `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <pkg-ref id="com.rangabot.desktop"><bundle-version><bundle CFBundleShortVersionString="1.2.0" CFBundleVersion="1.2.0" id="com.rangabot.desktop" path="RangaBot.app"/></bundle-version></pkg-ref>
  <product id="com.rangabot.desktop" version="1.2.0"/>
  <title>RangaBot</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <volume-check><allowed-os-versions><os-version min="15.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="default"><line choice="com.rangabot.desktop"/></line></choices-outline>
  <choice id="default" title="RangaBot" versStr="1.2.0"/>
  <choice id="com.rangabot.desktop" title="RangaBot" visible="false" customLocation="/Applications"><pkg-ref id="com.rangabot.desktop"/></choice>
  <pkg-ref id="com.rangabot.desktop" version="1.2.0" onConclusion="none" installKBytes="1" updateKBytes="0">#com.rangabot.desktop.pkg</pkg-ref>
</installer-gui-script>`;
  const packageInfo = `<?xml version="1.0" encoding="utf-8"?>
<pkg-info overwrite-permissions="true" relocatable="false" identifier="com.rangabot.desktop" postinstall-action="none" version="1.2.0" format-version="2" generator-version="synthetic" install-location="/Applications" auth="root" preserve-xattr="true">
  <payload numberOfFiles="2" installKBytes="1"/>
  <bundle path="./RangaBot.app" CFBundleShortVersionString="1.2.0" CFBundleVersion="1.2.0" id="com.rangabot.desktop"/>
  <bundle-version><bundle id="com.rangabot.desktop"/></bundle-version>
  <upgrade-bundle><bundle id="com.rangabot.desktop"/></upgrade-bundle>
  <update-bundle/><atomic-update-bundle/><strict-identifier><bundle id="com.rangabot.desktop"/></strict-identifier><relocate><bundle id="com.rangabot.desktop"/></relocate>
</pkg-info>`;
  try {
    writeFileSync(distributionPath, distribution);
    writeFileSync(packageInfoPath, packageInfo);
    const valid = inspectExpandedPackageMetadata(distributionPath, packageInfoPath, "1.2.0", "1.2.0");
    assert.equal(valid.installLocation, "/Applications");
    assert.equal(valid.packageInfoNumberOfFiles, 2);

    writeFileSync(distributionPath, distribution.replace('require-scripts="false"', 'require-scripts="true"'));
    assert.throws(
      () => inspectExpandedPackageMetadata(distributionPath, packageInfoPath, "1.2.0", "1.2.0"),
      /script-free exact RangaBot/u,
    );
    writeFileSync(distributionPath, distribution.replace("<installer-gui-script", '<!DOCTYPE installer-gui-script [<!ENTITY local SYSTEM "file:///etc/passwd">]><installer-gui-script'));
    assert.throws(
      () => inspectExpandedPackageMetadata(distributionPath, packageInfoPath, "1.2.0", "1.2.0"),
      /prohibited document type or entity/u,
    );
    writeFileSync(distributionPath, distribution);
    writeFileSync(packageInfoPath, packageInfo.replace('install-location="/Applications"', 'install-location="/tmp"'));
    assert.throws(
      () => inspectExpandedPackageMetadata(distributionPath, packageInfoPath, "1.2.0", "1.2.0"),
      /script-free exact RangaBot/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BOM validation permits only one unique typed ./RangaBot.app payload tree", () => {
  assert.deepEqual(validateMacPackageBomEntries(`0\t.\n40755\t./RangaBot.app\n40755\t./RangaBot.app/Contents\n`), {
    entries: 3,
    payloadRoot: "./RangaBot.app",
  });
  for (const invalid of [
    `0\t.\n40755\t./RangaBot.app\n40755\t./Other.app\n`,
    `0\t.\n40755\t./RangaBot.app\n100644\t../escape\n`,
    `0\t.\n40755\t./RangaBot.app\n40755\t./RangaBot.app\n`,
    `0\t.\n40755\t./RangaBot.app\n100644\t./RangaBot.app/../escape\n`,
    `0\t.\n100644\t./RangaBot.app\n`,
    `0\t.\n0\t./RangaBot.app\n`,
    `.\n./RangaBot.app\n`,
  ]) assert.throws(() => validateMacPackageBomEntries(invalid), /BOM/u);
});

function payloadFixture() {
  const payloadPath = mkdtempSync(join(tmpdir(), "rangabot-payload-inventory-"));
  const contentsPath = join(payloadPath, "RangaBot.app", "Contents");
  const macOSPath = join(contentsPath, "MacOS");
  mkdirSync(macOSPath, { recursive: true });
  writeFileSync(join(macOSPath, "RangaBot"), "synthetic executable\n");
  symlinkSync("MacOS", join(contentsPath, "Current"));
  return { payloadPath, contentsPath, macOSPath };
}

const exactPayloadBom = `0\t.
40755\t./RangaBot.app
40755\t./RangaBot.app/Contents
120755\t./RangaBot.app/Contents/Current
40755\t./RangaBot.app/Contents/MacOS
100755\t./RangaBot.app/Contents/MacOS/RangaBot
`;

test("BOM and expanded payload reconciliation binds every path, type, safe link, and declared count", () => {
  const value = payloadFixture();
  try {
    const reconciled = reconcileMacPackageBomWithPayload(exactPayloadBom, value.payloadPath, 5);
    assert.equal(reconciled.entries, 6);
    assert.equal(reconciled.payloadEntries, 6);
    assert.equal(reconciled.metadataEntries, 0);
    assert.match(reconciled.bomInventorySha256, /^[0-9a-f]{64}$/u);
    assert.match(reconciled.payloadInventorySha256, /^[0-9a-f]{64}$/u);

    const withMetadata = exactPayloadBom
      + "40755\t./._RangaBot.app\n"
      + "100755\t./RangaBot.app/Contents/MacOS/._RangaBot\n";
    assert.equal(
      reconcileMacPackageBomWithPayload(withMetadata, value.payloadPath, 5).metadataEntries,
      2,
    );
  } finally {
    rmSync(value.payloadPath, { recursive: true, force: true });
  }
});

test("BOM and expanded payload reconciliation rejects omissions, phantoms, type changes, and count drift", () => {
  const value = payloadFixture();
  try {
    const adversaries = [
      exactPayloadBom.replace("100755\t./RangaBot.app/Contents/MacOS/RangaBot\n", ""),
      exactPayloadBom + "100644\t./RangaBot.app/Contents/MacOS/phantom\n",
      exactPayloadBom.replace("100755\t./RangaBot.app/Contents/MacOS/RangaBot", "40755\t./RangaBot.app/Contents/MacOS/RangaBot"),
      exactPayloadBom + "100644\t./RangaBot.app/Contents/MacOS/._phantom\n",
    ];
    for (const source of adversaries) {
      assert.throws(
        () => reconcileMacPackageBomWithPayload(source, value.payloadPath, 5),
        /missing|mistypes|phantom/iu,
      );
    }
    assert.throws(
      () => reconcileMacPackageBomWithPayload(exactPayloadBom, value.payloadPath, 4),
      /numberOfFiles/u,
    );
  } finally {
    rmSync(value.payloadPath, { recursive: true, force: true });
  }
});

test("expanded payload reconciliation rejects escaping symlinks and hardlinks", () => {
  const escaping = payloadFixture();
  try {
    rmSync(join(escaping.contentsPath, "Current"));
    symlinkSync("../../../outside", join(escaping.contentsPath, "Current"));
    assert.throws(
      () => reconcileMacPackageBomWithPayload(exactPayloadBom, escaping.payloadPath, 5),
      /symbolic link/iu,
    );
  } finally {
    rmSync(escaping.payloadPath, { recursive: true, force: true });
  }

  const hardlinked = payloadFixture();
  try {
    linkSync(join(hardlinked.macOSPath, "RangaBot"), join(hardlinked.macOSPath, "RangaBot-copy"));
    const hardlinkBom = exactPayloadBom + "100755\t./RangaBot.app/Contents/MacOS/RangaBot-copy\n";
    assert.throws(
      () => reconcileMacPackageBomWithPayload(hardlinkBom, hardlinked.payloadPath, 6),
      /hardlinked/iu,
    );
  } finally {
    rmSync(hardlinked.payloadPath, { recursive: true, force: true });
  }
});

test("profile and product validation reject wildcard, development, stale, or mismatched identities", () => {
  const valid = {
    name: "RangaBot Mac App Store Distribution",
    uuid: "77abfcaa-0a25-4379-a71b-e11552f8f0be",
    teamId,
    applicationIdentifier: `${teamId}.com.rangabot.desktop`,
    platform: "OSX",
    expiresAt: "2099-08-24T12:00:00Z",
    sha256: "22".repeat(32),
    hasAdditionalTeamIdentifier: false,
    hasAdditionalPlatform: false,
    hasProvisionedDevices: false,
    getTaskAllow: null,
  } as const;
  assert.equal(validateMacProvisioningProfile(valid, teamId).applicationIdentifier, `${teamId}.com.rangabot.desktop`);
  assert.throws(() => validateMacProvisioningProfile({ ...valid, applicationIdentifier: `${teamId}.*` }, teamId));
  assert.throws(() => validateMacProvisioningProfile({ ...valid, getTaskAllow: true }, teamId));
  assert.throws(() => validateMacProvisioningProfile({ ...valid, hasProvisionedDevices: true }, teamId));
  assert.doesNotThrow(() => assertMacPackageProductIdentity({
    bundleIdentifier: "com.rangabot.desktop",
    marketingVersion: "1.2.0",
    buildNumber: "1.2.0",
    expectedProductVersion: "1.2.0",
    expectedBuildNumber: "1.2.0",
  }));
  assert.throws(() => assertMacPackageProductIdentity({
    bundleIdentifier: "com.rangabot.desktop",
    marketingVersion: "1.2.0",
    buildNumber: "1.2.1",
    expectedProductVersion: "1.2.0",
    expectedBuildNumber: "1.2.0",
  }));
});

test("Forge make invokes the post-maker verifier and evidence keeps acceptance gates truthful", () => {
  const forge = readFileSync("forge.config.cjs", "utf8");
  const verifier = readFileSync("scripts/verify-macos-mas-pkg.ts", "utf8");
  assert.match(forge, /postMake: async \(_config, makeResults\) => verifyMadeMacAppStorePackage\(makeResults\)/u);
  assert.match(forge, /packageArtifacts\.length !== 1/u);
  assert.match(forge, /macos-mas-pkg-darwin-/u);
  assert.match(verifier, /pkgutil", \["--check-signature"/u);
  assert.match(verifier, /pkgutil", \["--expand-full"/u);
  assert.match(verifier, /resolveMacInstallerSigningCertificate\(installerSigningIdentity, teamId\)/u);
  assert.match(verifier, /applicationSigningCertificate\.commonName/u);
  assert.match(verifier, /inspectExpandedMacPackage\(expandedRoot\)/u);
  assert.match(verifier, /xmllint/u);
  assert.match(verifier, /lsbom/u);
  assert.match(verifier, /componentPackagesFound: 1/u);
  assert.match(verifier, /unexpectedEntriesFound: 0/u);
  assert.match(verifier, /outerApplicationsFound: 1/u);
  assert.match(verifier, /cleanAccountAcceptance: "NOT_RUN"/u);
  assert.match(verifier, /testFlightAcceptance: "NOT_RUN"/u);
  assert.match(verifier, /publicReleaseEligible: false/u);
});
