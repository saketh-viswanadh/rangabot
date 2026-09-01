import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMacAppStoreCodeSignatureInspections,
  decodeProvisioningProfileBytes,
  expectedMacAppStoreChildEntitlements,
  expectedMacAppStoreMainEntitlements,
  parseCodesignEntitlementsRepresentation,
  validateMacAppStoreProvisioningProfile,
  type MacCodeSignatureInspection,
  type MacSigningCertificate,
} from "../lib/mac-app-store-signing-policy.ts";

const teamId = "MZPU6H4D3J";
const bundleId = "com.rangabot.desktop";
const applicationIdentifier = `${teamId}.${bundleId}`;
const now = new Date("2026-08-24T00:00:00.000Z");
const certificateBytes = Buffer.from("synthetic-selected-certificate", "utf8");

function certificate(overrides: Partial<MacSigningCertificate> = {}): MacSigningCertificate {
  return {
    sha1: "A".repeat(40),
    derBase64: certificateBytes.toString("base64"),
    commonName: "3rd Party Mac Developer Application: RangaBot (ACCOUNTREF)",
    organizationalUnit: teamId,
    issuerCommonName: "Apple Worldwide Developer Relations Certification Authority",
    validFrom: new Date("2026-08-01T00:00:00.000Z"),
    validTo: new Date("2027-08-24T00:00:00.000Z"),
    ...overrides,
  };
}

function distributionProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Platform: ["OSX"],
    TeamIdentifier: [teamId],
    ApplicationIdentifierPrefix: [teamId],
    CreationDate: new Date("2026-08-23T00:00:00.000Z"),
    ExpirationDate: new Date("2027-08-23T00:00:00.000Z"),
    DeveloperCertificates: [Buffer.from(certificateBytes)],
    Entitlements: {
      "com.apple.application-identifier": applicationIdentifier,
      "com.apple.developer.team-identifier": teamId,
      "keychain-access-groups": [`${teamId}.*`],
    },
    ...overrides,
  };
}

function validateDistribution(
  profile = distributionProfile(),
  selectedCertificate = certificate(),
) {
  return validateMacAppStoreProvisioningProfile({
    profile,
    certificate: selectedCertificate,
    mode: "app-store-distribution",
    teamId,
    bundleId,
    now,
  });
}

test("distribution profile is bound to exact platform, bundle, team, validity, type, and certificate DER", () => {
  const validated = validateDistribution();
  assert.equal(validated.applicationIdentifier, applicationIdentifier);
  assert.equal(validated.certificate.sha1, "A".repeat(40));
});

test("provisioning profile decoder rejects unsigned or untrusted CMS bytes", {
  skip: process.platform !== "darwin" && "requires the macOS OpenSSL verifier dependency",
}, () => {
  assert.throws(() => decodeProvisioningProfileBytes(Buffer.alloc(2_048, 0x41)), /certificate chain/);
});

test("profile validation rejects each semantic mismatch independently", () => {
  const cases: Array<readonly [string, () => void]> = [
    ["foreign platform", () => validateDistribution(distributionProfile({ Platform: ["iOS"] }))],
    ["foreign profile team", () => validateDistribution(distributionProfile({ TeamIdentifier: ["OTHERTEAM1"] }))],
    ["foreign prefix team", () => validateDistribution(distributionProfile({ ApplicationIdentifierPrefix: ["OTHERTEAM1"] }))],
    ["foreign bundle", () => validateDistribution(distributionProfile({
      Entitlements: {
        "com.apple.application-identifier": `${teamId}.com.example.other`,
        "com.apple.developer.team-identifier": teamId,
      },
    }))],
    ["development profile used for distribution", () => validateDistribution(distributionProfile({
      ProvisionedDevices: ["SYNTHETIC-MAC"],
      Entitlements: {
        "com.apple.application-identifier": applicationIdentifier,
        "com.apple.developer.team-identifier": teamId,
        "get-task-allow": true,
      },
    }))],
    ["expired profile", () => validateDistribution(distributionProfile({ ExpirationDate: new Date("2026-08-23T23:59:59.000Z") }))],
    ["unbound certificate DER", () => validateDistribution(distributionProfile({ DeveloperCertificates: [Buffer.from("other")] }))],
    ["wrong certificate type", () => validateDistribution(distributionProfile(), certificate({ commonName: "Apple Development: RangaBot (ACCOUNTREF)" }))],
    ["wrong certificate team OU", () => validateDistribution(distributionProfile(), certificate({ organizationalUnit: "OTHERTEAM1" }))],
    ["non-Apple certificate issuer", () => validateDistribution(distributionProfile(), certificate({ issuerCommonName: "Example Issuer" }))],
    ["certificate expires before profile", () => validateDistribution(distributionProfile(), certificate({ validTo: new Date("2027-01-01T00:00:00.000Z") }))],
  ];
  for (const [label, run] of cases) assert.throws(run, label);
  assert.equal(cases.length, 11);
});

test("development mode accepts only a device-bound get-task-allow profile and target-team Apple Development certificate", () => {
  const profile = distributionProfile({
    ProvisionedDevices: ["SYNTHETIC-MAC"],
    Entitlements: {
      "com.apple.application-identifier": applicationIdentifier,
      "com.apple.developer.team-identifier": teamId,
      "get-task-allow": true,
    },
  });
  const result = validateMacAppStoreProvisioningProfile({
    profile,
    certificate: certificate({ commonName: "Apple Development: RangaBot (ACCOUNTREF)" }),
    mode: "app-store-development",
    teamId,
    bundleId,
    now,
  });
  assert.equal(result.applicationIdentifier, applicationIdentifier);

  delete profile.ProvisionedDevices;
  assert.throws(() => validateMacAppStoreProvisioningProfile({
    profile,
    certificate: certificate({ commonName: "Apple Development: RangaBot (ACCOUNTREF)" }),
    mode: "app-store-development",
    teamId,
    bundleId,
    now,
  }), /development profile/);
});

const baseMainEntitlements = {
  "com.apple.security.app-sandbox": true,
  "com.apple.security.files.bookmarks.app-scope": true,
  "com.apple.security.files.user-selected.read-write": true,
  "com.apple.security.network.client": true,
  "com.apple.security.network.server": true,
};
const baseChildEntitlements = {
  "com.apple.security.app-sandbox": true,
  "com.apple.security.inherit": true,
};

test("entitlement templates reject any undeclared capability", () => {
  const validated = validateDistribution();
  const main = expectedMacAppStoreMainEntitlements(baseMainEntitlements, validated, teamId);
  const child = expectedMacAppStoreChildEntitlements(baseChildEntitlements);
  assert.equal(main["com.apple.application-identifier"], applicationIdentifier);
  assert.deepEqual(child, baseChildEntitlements);
  assert.throws(() => expectedMacAppStoreMainEntitlements({
    ...baseMainEntitlements,
    "com.apple.security.device.camera": true,
  }, validated, teamId), /exactly the approved/);
  assert.throws(() => expectedMacAppStoreChildEntitlements({
    ...baseChildEntitlements,
    "com.apple.security.network.client": true,
  }), /exactly sandbox and inherit/);
});

function signature(
  path: string,
  entitlements: Record<string, unknown>,
  overrides: Partial<MacCodeSignatureInspection> = {},
): MacCodeSignatureInspection {
  return {
    path,
    identifier: path === "/RangaBot.app" || path.endsWith("/MacOS/RangaBot") ? bundleId : `signed.${path.split("/").at(-1)}`,
    teamIdentifier: teamId,
    authorities: [
      certificate().commonName,
      certificate().issuerCommonName,
      "Apple Root CA",
    ],
    leafCertificateSha1: certificate().sha1,
    entitlements,
    ...overrides,
  };
}

function signatureFixture() {
  const validated = validateDistribution();
  const mainEntitlements = expectedMacAppStoreMainEntitlements(baseMainEntitlements, validated, teamId);
  const childEntitlements = expectedMacAppStoreChildEntitlements(baseChildEntitlements);
  const appPath = "/RangaBot.app";
  const mainExecutable = "/RangaBot.app/Contents/MacOS/RangaBot";
  const inspections = [
    signature(appPath, mainEntitlements),
    signature(mainExecutable, mainEntitlements),
    signature("/RangaBot.app/Contents/Frameworks/RangaBot Helper.app/Contents/MacOS/RangaBot Helper", childEntitlements),
    signature("/RangaBot.app/Contents/Resources/rangabot-resources/runtime/ollama/ollama", childEntitlements),
    signature("/RangaBot.app/Contents/Resources/rangabot-resources/node_modules/native.node", {}),
  ];
  return { appPath, mainExecutable, inspections, mainEntitlements, childEntitlements };
}

function assertSignatureFixture(inspections: readonly MacCodeSignatureInspection[]) {
  const fixture = signatureFixture();
  assertMacAppStoreCodeSignatureInspections({
    inspections,
    mainPaths: new Set([fixture.appPath, fixture.mainExecutable]),
    teamId,
    leafAuthority: certificate().commonName,
    leafCertificateSha1: certificate().sha1,
    issuerAuthority: certificate().issuerCommonName,
    mainEntitlements: fixture.mainEntitlements,
    childEntitlements: fixture.childEntitlements,
    bundleId,
  });
}

test("complete signature inventory accepts exact main, helper, Ollama, and native-module signatures", () => {
  const inspections = [
    ...signatureFixture().inspections,
    signature("/RangaBot.app/Contents/Frameworks/Electron.framework/Versions/A/Electron", {}),
    signature("/RangaBot.app/Contents/Resources/native.dylib", {}),
    signature("/RangaBot.app/Contents/Resources/native.node", {}),
  ];
  assert.doesNotThrow(() => assertSignatureFixture(inspections));
});

test("codesign abstract entitlements accept exact scalar dictionaries and reject malformed values", () => {
  assert.deepEqual(parseCodesignEntitlementsRepresentation(`
[Dict]
\t[Key] com.apple.application-identifier
\t[Value]
\t\t[String] ${applicationIdentifier}
\t[Key] com.apple.security.app-sandbox
\t[Value]
\t\t[Bool] true
`), {
    "com.apple.application-identifier": applicationIdentifier,
    "com.apple.security.app-sandbox": true,
  });
  assert.deepEqual(parseCodesignEntitlementsRepresentation(""), {});
  assert.throws(() => parseCodesignEntitlementsRepresentation("[Dict]\n[Key] x\n[Value]\n[Array]"));
  assert.throws(() => parseCodesignEntitlementsRepresentation("[Dict]\n[Key] x\n[Value]\n[Bool] maybe"));
});

test("complete signature inventory rejects wrong team, authority, exact leaf certificate, identifier, entitlement, and missing main", () => {
  const cases = [
    signatureFixture().inspections.map((entry, index) => index === 3 ? { ...entry, teamIdentifier: "OTHERTEAM1" } : entry),
    signatureFixture().inspections.map((entry, index) => index === 2 ? { ...entry, authorities: ["Other", ...entry.authorities.slice(1)] } : entry),
    signatureFixture().inspections.map((entry, index) => index === 3 ? {
      ...entry,
      // A renewed certificate can legitimately retain the same CN and team.
      // Its fingerprint must still be rejected as not profile-bound.
      leafCertificateSha1: "B".repeat(40),
    } : entry),
    signatureFixture().inspections.map((entry, index) => index === 0 ? { ...entry, identifier: "com.example.other" } : entry),
    signatureFixture().inspections.map((entry, index) => index === 4 ? {
      ...entry,
      entitlements: { ...entry.entitlements, "com.apple.security.network.client": true },
    } : entry),
    signatureFixture().inspections.slice(1),
  ];
  for (const inspections of cases) assert.throws(() => assertSignatureFixture(inspections));
  assert.equal(cases.length, 6);
});
