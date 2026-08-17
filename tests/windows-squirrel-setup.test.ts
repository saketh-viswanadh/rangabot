import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  inspectSquirrelPayloadResourceBuffer,
  verifySquirrelNupkgApplicationPayload,
  verifySquirrelSetupEmbeddedPayload,
} from "../lib/windows-squirrel-setup.ts";

const require = createRequire(import.meta.url);
const {
  EXPECTED_PATCHED_CHARACTERISTICS,
  PATCHED_BINARIES,
  assertPreparedSquirrelVendor,
  inspectPe32X86CharacteristicsBuffer,
  patchLargeAddressAwareBuffer,
  preparePatchedSquirrelVendor,
} = require("../desktop/electron/windows-squirrel-vendor.cjs") as {
  EXPECTED_PATCHED_CHARACTERISTICS: number;
  PATCHED_BINARIES: ReadonlyArray<Readonly<{
    name: string;
    bytes: number;
    originalSha256: string;
    patchedSha256: string;
  }>>;
  assertPreparedSquirrelVendor(directory: string): Readonly<Record<string, unknown>>;
  inspectPe32X86CharacteristicsBuffer(source: Buffer, label?: string): Readonly<{
    characteristics: number;
    characteristicsOffset: number;
  }>;
  patchLargeAddressAwareBuffer(source: Buffer, policy: (typeof PATCHED_BINARIES)[number]): Buffer;
  preparePatchedSquirrelVendor(input: {
    electronWinstallerRoot: string;
    destinationDirectory: string;
  }): Readonly<{ destinationDirectory: string }>;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(source: Buffer) {
  let crc = 0xffffffff;
  for (const byte of source) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ReadonlyArray<Readonly<{
  name: string;
  content: Buffer;
  deflate?: boolean;
  descriptor?: boolean;
}>>) {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = entry.deflate ? deflateRawSync(entry.content) : entry.content;
    const method = entry.deflate ? 8 : 0;
    const checksum = crc32(entry.content);
    const flags = 0x0800 | (entry.descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(entry.content.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const descriptor = entry.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(entry.content.length, 12);
    }
    localRecords.push(local, body, descriptor);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length + body.length + descriptor.length;
  }
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

function syntheticSquirrelSetup(payload: Buffer, largeAddressAware = true) {
  const peOffset = 0x80;
  const optionalBytes = 224;
  const sectionOffset = peOffset + 24 + optionalBytes;
  const textRawOffset = 0x200;
  const textRawBytes = 0x200;
  const rawOffset = 0x400;
  const textRva = 0x1000;
  const resourceRva = 0x2000;
  const payloadRelativeOffset = 128;
  const resourceBytes = payloadRelativeOffset + payload.length;
  const resourceRawBytes = Math.ceil(resourceBytes / 0x200) * 0x200;
  const relocationRva = Math.ceil((resourceRva + resourceBytes) / 0x1000) * 0x1000;
  const relocationRawOffset = rawOffset + resourceRawBytes;
  const relocationRawBytes = 0x200;
  const relocationVirtualBytes = 0x20;
  const source = Buffer.alloc(relocationRawOffset + relocationRawBytes);
  source.writeUInt16LE(0x5a4d, 0);
  source.writeUInt32LE(peOffset, 0x3c);
  source.writeUInt32LE(0x00004550, peOffset);
  source.writeUInt16LE(0x014c, peOffset + 4);
  source.writeUInt16LE(3, peOffset + 6);
  source.writeUInt16LE(optionalBytes, peOffset + 20);
  source.writeUInt16LE(largeAddressAware ? 0x0122 : 0x0102, peOffset + 22);
  const optional = peOffset + 24;
  source.writeUInt16LE(0x10b, optional);
  source.writeUInt32LE(textRawBytes, optional + 4);
  source.writeUInt32LE(resourceRawBytes + relocationRawBytes, optional + 8);
  source.writeUInt32LE(textRva, optional + 16);
  source.writeUInt32LE(textRva, optional + 20);
  source.writeUInt32LE(resourceRva, optional + 24);
  source.writeUInt32LE(0x00400000, optional + 28);
  source.writeUInt32LE(0x1000, optional + 32);
  source.writeUInt32LE(0x200, optional + 36);
  source.writeUInt32LE(Math.ceil((relocationRva + relocationVirtualBytes) / 0x1000) * 0x1000, optional + 56);
  source.writeUInt32LE(0x200, optional + 60);
  source.writeUInt16LE(2, optional + 68);
  source.writeUInt16LE(0x140, optional + 70);
  source.writeUInt32LE(16, optional + 92);
  source.writeUInt32LE(resourceRva, optional + 112);
  source.writeUInt32LE(resourceBytes, optional + 116);
  source.writeUInt32LE(relocationRva, optional + 136);
  source.writeUInt32LE(relocationVirtualBytes, optional + 140);
  source.write(".text\0\0\0", sectionOffset, "ascii");
  source.writeUInt32LE(0x100, sectionOffset + 8);
  source.writeUInt32LE(textRva, sectionOffset + 12);
  source.writeUInt32LE(textRawBytes, sectionOffset + 16);
  source.writeUInt32LE(textRawOffset, sectionOffset + 20);
  source.writeUInt32LE(0x60000020, sectionOffset + 36);
  const resourceSection = sectionOffset + 40;
  source.write(".rsrc\0\0\0", resourceSection, "ascii");
  source.writeUInt32LE(resourceBytes, resourceSection + 8);
  source.writeUInt32LE(resourceRva, resourceSection + 12);
  source.writeUInt32LE(resourceRawBytes, resourceSection + 16);
  source.writeUInt32LE(rawOffset, resourceSection + 20);
  source.writeUInt32LE(0x40000040, resourceSection + 36);
  const relocationSection = sectionOffset + 80;
  source.write(".reloc\0\0", relocationSection, "ascii");
  source.writeUInt32LE(relocationVirtualBytes, relocationSection + 8);
  source.writeUInt32LE(relocationRva, relocationSection + 12);
  source.writeUInt32LE(relocationRawBytes, relocationSection + 16);
  source.writeUInt32LE(relocationRawOffset, relocationSection + 20);
  source.writeUInt32LE(0x42000040, relocationSection + 36);
  source.fill(0x90, textRawOffset, textRawOffset + textRawBytes);
  source.fill(0x55, relocationRawOffset, relocationRawOffset + relocationRawBytes);

  const resource = rawOffset;
  source.writeUInt16LE(1, resource + 12);
  source.writeUInt32LE(0x80000000 + 24, resource + 16);
  source.writeUInt32LE(0x80000000 + 40, resource + 20);
  source.writeUInt16LE(4, resource + 24);
  source.write("DATA", resource + 26, "utf16le");
  source.writeUInt16LE(1, resource + 40 + 14);
  source.writeUInt32LE(131, resource + 56);
  source.writeUInt32LE(0x80000000 + 64, resource + 60);
  source.writeUInt16LE(1, resource + 64 + 14);
  source.writeUInt32LE(0x0409, resource + 80);
  source.writeUInt32LE(88, resource + 84);
  source.writeUInt32LE(resourceRva + payloadRelativeOffset, resource + 88);
  source.writeUInt32LE(payload.length, resource + 92);
  payload.copy(source, resource + payloadRelativeOffset);
  return source;
}

test("Squirrel vendor staging makes only the two exact locked PE32 inputs large-address-aware", () => {
  const projectRoot = realpathSync(resolve(import.meta.dirname, ".."));
  const packageRoot = resolve(projectRoot, "node_modules", "electron-winstaller");
  for (const policy of PATCHED_BINARIES) {
    const original = readFileSync(resolve(packageRoot, "vendor", policy.name));
    const patched = patchLargeAddressAwareBuffer(original, policy);
    assert.equal(patched.length, policy.bytes);
    assert.equal(createHash("sha256").update(patched).digest("hex"), policy.patchedSha256);
    assert.equal(inspectPe32X86CharacteristicsBuffer(patched, policy.name).characteristics, EXPECTED_PATCHED_CHARACTERISTICS);
    const changed = patched.reduce((count, byte, index) => count + Number(byte !== original[index]), 0);
    assert.equal(changed, 1);
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-squirrel-vendor-")));
  try {
    const staged = preparePatchedSquirrelVendor({
      electronWinstallerRoot: packageRoot,
      destinationDirectory: join(root, "vendor"),
    });
    assert.equal(staged.destinationDirectory, join(root, "vendor"));
    assert.doesNotThrow(() => assertPreparedSquirrelVendor(staged.destinationDirectory));
    assert.deepEqual(
      readFileSync(join(staged.destinationDirectory, "7z.exe")),
      readFileSync(join(packageRoot, "vendor", "7z-x64.exe")),
    );
    assert.deepEqual(
      readFileSync(join(staged.destinationDirectory, "7z.dll")),
      readFileSync(join(packageRoot, "vendor", "7z-x64.dll")),
    );
    assert.match(readFileSync(join(staged.destinationDirectory, "ELECTRON-WINSTALLER-LICENSE.txt"), "utf8"), /MIT License|Permission is hereby granted/);
    const nugetPath = join(staged.destinationDirectory, "nuget.exe");
    writeFileSync(nugetPath, Buffer.concat([readFileSync(nugetPath), Buffer.from("tamper")]));
    assert.throws(
      () => assertPreparedSquirrelVendor(staged.destinationDirectory),
      /complete inventory|manifest is invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Squirrel Setup verifier proves the exact embedded full package and rejects a stub", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-squirrel-setup-")));
  const nupkgName = "RangaBot-0.1.0-full.nupkg";
  const nupkg = Buffer.from("synthetic full nupkg bytes\n");
  const update = readFileSync(new URL("../node_modules/electron-winstaller/vendor/Squirrel.exe", import.meta.url));
  const release = Buffer.from(`${createHash("sha1").update(nupkg).digest("hex")} ${nupkgName} ${nupkg.length}\n`);
  const embeddedZip = zip([
    { name: "Update.exe", content: update },
    { name: nupkgName, content: nupkg, deflate: true },
    { name: "background.gif", content: Buffer.from("gif"), descriptor: true },
    { name: "setupIcon.ico", content: Buffer.from("ico") },
    { name: "RELEASES", content: release },
  ]);
  const setup = syntheticSquirrelSetup(embeddedZip);
  const setupPath = join(root, "RangaBot-win32-x64-Setup.exe");
  const setupTemplatePath = join(root, "Setup.exe");
  const nupkgPath = join(root, nupkgName);
  try {
    const resource = inspectSquirrelPayloadResourceBuffer(setup);
    assert.equal(resource.payloadBytes, embeddedZip.length);
    assert.equal(resource.largeAddressAware, true);
    writeFileSync(setupPath, setup);
    writeFileSync(setupTemplatePath, syntheticSquirrelSetup(Buffer.from("template resource")));
    writeFileSync(nupkgPath, nupkg);
    const evidence = await verifySquirrelSetupEmbeddedPayload({
      setupPath,
      setupTemplatePath,
      nupkgPath,
      expectedNupkgBytes: nupkg.length,
      expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
      expectedReleases: release.toString("utf8"),
    });
    assert.equal(evidence.embeddedNupkgName, nupkgName);
    assert.equal(evidence.embeddedNupkgBytes, nupkg.length);
    assert.equal(evidence.entries.length, 5);

    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: "0".repeat(64),
        expectedReleases: release.toString("utf8"),
      }),
      /does not embed the exact generated full package/,
    );
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: `0`.repeat(40) + ` ${nupkgName} ${nupkg.length}\n`,
      }),
      /does not match the external Squirrel RELEASES/,
    );

    const alteredLauncher = Buffer.from(setup);
    alteredLauncher[0x200] ^= 1;
    writeFileSync(setupPath, alteredLauncher);
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /does not match the locked Squirrel launcher code sections/,
    );

    const alteredCoffHeader = Buffer.from(setup);
    alteredCoffHeader.writeUInt32LE(1, 0x80 + 8);
    writeFileSync(setupPath, alteredCoffHeader);
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /does not match the locked Squirrel launcher header/,
    );

    const alteredImportDirectory = Buffer.from(setup);
    const optionalHeaderOffset = 0x80 + 24;
    alteredImportDirectory.writeUInt32LE(0x1000, optionalHeaderOffset + 104);
    alteredImportDirectory.writeUInt32LE(4, optionalHeaderOffset + 108);
    writeFileSync(setupPath, alteredImportDirectory);
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /does not match the locked Squirrel launcher header/,
    );

    const invalidSizeOfImage = Buffer.from(setup);
    invalidSizeOfImage.writeUInt32LE(0, optionalHeaderOffset + 56);
    writeFileSync(setupPath, invalidSizeOfImage);
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /invalid PE SizeOfImage/,
    );

    const alteredTextAddress = Buffer.from(setup);
    const sectionTableOffset = optionalHeaderOffset + 224;
    alteredTextAddress.writeUInt32LE(0x3000, sectionTableOffset + 12);
    writeFileSync(setupPath, alteredTextAddress);
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /entry point|overlapping PE sections|launcher header/,
    );

    const mismatchedLocal = Buffer.from(embeddedZip);
    mismatchedLocal.writeUInt32LE((mismatchedLocal.readUInt32LE(14) ^ 1) >>> 0, 14);
    writeFileSync(setupPath, syntheticSquirrelSetup(mismatchedLocal));
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /mismatched embedded ZIP local evidence/,
    );

    const eocdOffset = embeddedZip.length - 22;
    const centralOffset = embeddedZip.readUInt32LE(eocdOffset + 16);
    const gappedZip = Buffer.concat([
      embeddedZip.subarray(0, centralOffset),
      Buffer.from([0]),
      embeddedZip.subarray(centralOffset),
    ]);
    gappedZip.writeUInt32LE(centralOffset + 1, eocdOffset + 1 + 16);
    writeFileSync(setupPath, syntheticSquirrelSetup(gappedZip));
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /unexplained embedded ZIP gap/,
    );

    const trailingCentralGap = Buffer.concat([
      embeddedZip.subarray(0, eocdOffset),
      Buffer.from([0]),
      embeddedZip.subarray(eocdOffset),
    ]);
    writeFileSync(setupPath, syntheticSquirrelSetup(trailingCentralGap));
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /invalid embedded ZIP central directory/,
    );

    const commentedZip = Buffer.concat([embeddedZip, Buffer.from("JUNK")]);
    commentedZip.writeUInt16LE(4, eocdOffset + 20);
    writeFileSync(setupPath, syntheticSquirrelSetup(commentedZip));
    await assert.rejects(
      verifySquirrelSetupEmbeddedPayload({
        setupPath,
        setupTemplatePath,
        nupkgPath,
        expectedNupkgBytes: nupkg.length,
        expectedNupkgSha256: createHash("sha256").update(nupkg).digest("hex"),
        expectedReleases: release.toString("utf8"),
      }),
      /invalid embedded ZIP central directory/,
    );

    const wrongResourceId = syntheticSquirrelSetup(embeddedZip);
    wrongResourceId.writeUInt32LE(132, 0x400 + 56);
    assert.throws(
      () => inspectSquirrelPayloadResourceBuffer(wrongResourceId),
      /does not contain one exact Squirrel payload resource/,
    );
    const alternateLanguage = syntheticSquirrelSetup(embeddedZip);
    const resourceBase = 0x400;
    const payloadDescriptor = Buffer.from(alternateLanguage.subarray(resourceBase + 88, resourceBase + 104));
    alternateLanguage.writeUInt16LE(2, resourceBase + 64 + 14);
    alternateLanguage.writeUInt32LE(96, resourceBase + 84);
    alternateLanguage.writeUInt32LE(0x040c, resourceBase + 88);
    alternateLanguage.writeUInt32LE(112, resourceBase + 92);
    payloadDescriptor.copy(alternateLanguage, resourceBase + 96);
    payloadDescriptor.copy(alternateLanguage, resourceBase + 112);
    assert.throws(
      () => inspectSquirrelPayloadResourceBuffer(alternateLanguage),
      /exactly one Squirrel payload language resource/,
    );
    const descendingLanguage = Buffer.from(alternateLanguage);
    descendingLanguage.writeUInt32LE(0x040c, resourceBase + 80);
    descendingLanguage.writeUInt32LE(0x0409, resourceBase + 88);
    assert.throws(
      () => inspectSquirrelPayloadResourceBuffer(descendingLanguage),
      /resource IDs that are not strictly sorted and unique/,
    );
    const duplicateLanguage = Buffer.from(alternateLanguage);
    duplicateLanguage.writeUInt32LE(0x0409, resourceBase + 88);
    assert.throws(
      () => inspectSquirrelPayloadResourceBuffer(duplicateLanguage),
      /resource IDs that are not strictly sorted and unique/,
    );

    const stub = syntheticSquirrelSetup(Buffer.from("not a zip"));
    assert.throws(() => inspectSquirrelPayloadResourceBuffer(stub), /payload range|PE resource|ZIP|Squirrel payload/);
    assert.throws(() => inspectSquirrelPayloadResourceBuffer(syntheticSquirrelSetup(embeddedZip, false)), /large-address-aware/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Squirrel NUPKG verifier binds the installed executable and desktop manifest", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-squirrel-nupkg-")));
  const nupkgPath = join(root, "RangaBot-0.1.0-full.nupkg");
  const application = Buffer.from("synthetic packaged RangaBot.exe\n");
  const manifest = Buffer.from('{"desktopArtifactId":"synthetic"}\n');
  const packageBytes = zip([
    { name: "_rels/.rels", content: Buffer.from("rels") },
    { name: "lib/net45/RangaBot.exe", content: application, deflate: true },
    {
      name: "lib/net45/resources/rangabot-resources/desktop/manifest.json",
      content: manifest,
      descriptor: true,
    },
    { name: "RangaBot.nuspec", content: Buffer.from("nuspec") },
  ]);
  try {
    writeFileSync(nupkgPath, packageBytes);
    const evidence = await verifySquirrelNupkgApplicationPayload({
      nupkgPath,
      expectedApplicationBytes: application.length,
      expectedApplicationSha256: createHash("sha256").update(application).digest("hex"),
      expectedManifestBytes: manifest.length,
      expectedManifestSha256: createHash("sha256").update(manifest).digest("hex"),
    });
    assert.equal(evidence.applicationPath, "lib/net45/RangaBot.exe");
    assert.equal(evidence.manifestPath, "lib/net45/resources/rangabot-resources/desktop/manifest.json");

    await assert.rejects(
      verifySquirrelNupkgApplicationPayload({
        nupkgPath,
        expectedApplicationBytes: application.length,
        expectedApplicationSha256: "0".repeat(64),
        expectedManifestBytes: manifest.length,
        expectedManifestSha256: createHash("sha256").update(manifest).digest("hex"),
      }),
      /does not contain the exact packaged RangaBot\.exe/,
    );

    writeFileSync(nupkgPath, zip([
      { name: "lib/net45/RangaBot.exe", content: application },
      { name: "lib/net45/rangabot.exe", content: Buffer.from("collision") },
      { name: "lib/net45/resources/rangabot-resources/desktop/manifest.json", content: manifest },
    ]));
    await assert.rejects(
      verifySquirrelNupkgApplicationPayload({
        nupkgPath,
        expectedApplicationBytes: application.length,
        expectedApplicationSha256: createHash("sha256").update(application).digest("hex"),
        expectedManifestBytes: manifest.length,
        expectedManifestSha256: createHash("sha256").update(manifest).digest("hex"),
      }),
      /case-insensitive path collisions/,
    );

    writeFileSync(nupkgPath, zip([
      { name: "../escape", content: Buffer.from("unsafe") },
      { name: "lib/net45/RangaBot.exe", content: application },
      { name: "lib/net45/resources/rangabot-resources/desktop/manifest.json", content: manifest },
    ]));
    await assert.rejects(
      verifySquirrelNupkgApplicationPayload({
        nupkgPath,
        expectedApplicationBytes: application.length,
        expectedApplicationSha256: createHash("sha256").update(application).digest("hex"),
        expectedManifestBytes: manifest.length,
        expectedManifestSha256: createHash("sha256").update(manifest).digest("hex"),
      }),
      /unsafe embedded ZIP entry name/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
