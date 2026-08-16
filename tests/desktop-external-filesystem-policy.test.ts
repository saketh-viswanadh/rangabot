import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  assertExternalImportAccess,
  assertProfileBackupExportAccess,
  assertExternalFilesystemPathAccess,
  preflightVerificationExternalFilesystemRegistries,
  RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV,
  RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV,
  VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  VERIFICATION_LOCAL_MODEL_POLICY,
  verificationLocalModelDisabled,
} from "../lib/desktop-external-filesystem-policy.ts";
import {
  allowRepository,
  listAllowedRepositories,
  resetRepositoryRegistryPathForTests,
  setRepositoryRegistryPathForTests,
} from "../lib/repositories.ts";
import {
  approveDataset,
  listApprovedDatasets,
  resetDatasetRegistryPathForTests,
  setDatasetRegistryPathForTests,
} from "../lib/datasets.ts";
import { inspectDatasetSchema, validateApprovedDataset } from "../lib/sql-runtime.ts";
import { createDesktopLaunch } from "../desktop/electron/launch-environment.ts";
import { getOllamaStatus } from "../lib/providers/ollama.ts";
import { embedKnowledgeQuery } from "../lib/knowledge.ts";
import { openProfileRegistry } from "../lib/profile-registry.ts";

const policyEnvironment = {
  [RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV]: VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  [RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV]: VERIFICATION_LOCAL_MODEL_POLICY,
} as const;

async function withVerificationPolicy<T>(action: () => T | Promise<T>) {
  const external = process.env[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV];
  const model = process.env[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV];
  process.env[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV] = VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS;
  process.env[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV] = VERIFICATION_LOCAL_MODEL_POLICY;
  try { return await action(); }
  finally {
    if (external === undefined) delete process.env[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV];
    else process.env[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV] = external;
    if (model === undefined) delete process.env[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV];
    else process.env[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV] = model;
  }
}

test("verification deny policy rejects every external path form before target inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-verification-external-"));
  const outside = mkdtempSync(join(tmpdir(), "rangabot-verification-outside-"));
  const nested = join(root, "fixtures", "nested");
  const realDirectory = join(root, "real-directory");
  const linkedDirectory = join(root, "linked-directory");
  const dataset = join(nested, "sales.csv");
  mkdirSync(nested, { recursive: true });
  mkdirSync(realDirectory);
  writeFileSync(dataset, "amount\n10\n", { mode: 0o600 });
  symlinkSync(realDirectory, linkedDirectory, "dir");
  setRepositoryRegistryPathForTests(join(root, "repositories.json"));
  setDatasetRegistryPathForTests(join(root, "datasets.json"));
  try {
    await withVerificationPolicy(async () => {
      const inputs = [
        join(homedir(), "Documents", "private-project"),
        join(outside, "outside.csv"),
        realDirectory,
        join(linkedDirectory, "child"),
        join(root, "fixtures", "..", "real-directory"),
        `${root}/fixtures/%2e%2e/real-directory`,
        `file://${dataset}`,
        "https://example.invalid/data.csv",
        "relative/data.csv",
        dataset,
      ];
      for (const input of inputs) {
        assert.throws(
          () => assertExternalFilesystemPathAccess(input, "dataset-approval"),
          /External filesystem access is disabled/,
          input,
        );
        assert.throws(() => allowRepository(input), /External filesystem access is disabled/, input);
        assert.throws(() => approveDataset(input), /External filesystem access is disabled/, input);
        assert.throws(() => validateApprovedDataset(input), /External filesystem access is disabled/, input);
        await assert.rejects(() => inspectDatasetSchema(input), /External filesystem access is disabled/, input);
      }
      assert.deepEqual(listAllowedRepositories(), []);
      assert.deepEqual(listApprovedDatasets(), []);
    });
  } finally {
    resetRepositoryRegistryPathForTests();
    resetDatasetRegistryPathForTests();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("read-only startup preflight rejects preseeded approvals without opening their targets", () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-data-")));
  const sentinelRoot = mkdtempSync(join(tmpdir(), "rangabot-verification-sentinel-"));
  const sentinel = join(sentinelRoot, "must-not-open.csv");
  writeFileSync(sentinel, "secret-sentinel\n", { mode: 0o600 });
  const oldTime = new Date("2001-01-01T00:00:00.000Z");
  utimesSync(sentinel, oldTime, oldTime);
  const before = lstatSync(sentinel, { bigint: true });
  writeFileSync(join(dataRoot, "repositories.json"), `${JSON.stringify([{
    id: "outside", name: "outside", path: sentinelRoot, addedAt: "2026-08-12T00:00:00.000Z",
  }])}\n`, { mode: 0o600 });
  chmodSync(sentinel, 0o000);
  try {
    assert.throws(
      () => preflightVerificationExternalFilesystemRegistries({ dataRoot, environment: policyEnvironment }),
      /External filesystem access is disabled/,
    );
    const after = lstatSync(sentinel, { bigint: true });
    assert.equal(after.atimeNs, before.atimeNs);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.size, before.size);
  } finally {
    chmodSync(sentinel, 0o600);
    assert.equal(readFileSync(sentinel, "utf8"), "secret-sentinel\n");
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(sentinelRoot, { recursive: true, force: true });
  }
});

test("read-only startup preflight accepts only missing or empty registries", () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-data-")));
  try {
    assert.deepEqual(
      preflightVerificationExternalFilesystemRegistries({ dataRoot, environment: policyEnvironment })
        .map(({ kind, status }) => ({ kind, status })),
      [{ kind: "repositories", status: "missing" }, { kind: "datasets", status: "missing" }],
    );
    writeFileSync(join(dataRoot, "repositories.json"), "[]\n", { mode: 0o600 });
    writeFileSync(join(dataRoot, "datasets.json"), "[]\n", { mode: 0o600 });
    assert.deepEqual(
      preflightVerificationExternalFilesystemRegistries({ dataRoot, environment: policyEnvironment })
        .map(({ kind, status }) => ({ kind, status })),
      [{ kind: "repositories", status: "empty" }, { kind: "datasets", status: "empty" }],
    );
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

function filesystemSnapshot(root: string) {
  const records: string[] = [];
  const visit = (path: string) => {
    const status = lstatSync(path, { bigint: true });
    records.push([
      relative(root, path) || ".",
      status.mode.toString(),
      status.size.toString(),
      status.mtimeNs.toString(),
      status.ctimeNs.toString(),
      status.nlink.toString(),
    ].join(":"));
    if (status.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(root);
  return records;
}

test("read-only startup preflight validates every registered profile plus the legacy root", () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-profiles-")));
  const registry = openProfileRegistry({ managedRoot: dataRoot });
  const defaultId = "11111111-1111-4111-8111-111111111111";
  const personalId = "22222222-2222-4222-8222-222222222222";
  try {
    const initialized = registry.initializeDefault({ profileId: defaultId });
    mkdirSync(registry.layout.profilesRoot, { mode: 0o700 });
    chmodSync(registry.layout.profilesRoot, 0o700);
    const created = registry.create({
      displayName: "Synthetic Personal",
      kind: "personal",
      expectedGeneration: initialized.generation,
      profileId: personalId,
    });
    assert.equal(created.profiles.length, 2);
    for (const profileId of [defaultId, personalId]) {
      mkdirSync(registry.profileRoot(profileId), { mode: 0o700 });
      chmodSync(registry.profileRoot(profileId), 0o700);
    }
    writeFileSync(join(dataRoot, "datasets.json"), "[]\n", { mode: 0o600 });
    writeFileSync(join(registry.profileRoot(defaultId), "repositories.json"), "[]\n", { mode: 0o600 });
    writeFileSync(join(registry.profileRoot(personalId), "repositories.json"), "[]\n", { mode: 0o600 });
    writeFileSync(join(registry.profileRoot(personalId), "datasets.json"), "[]\n", { mode: 0o600 });

    const before = filesystemSnapshot(dataRoot);
    const result = preflightVerificationExternalFilesystemRegistries({
      dataRoot,
      environment: policyEnvironment,
    });
    assert.deepEqual(result.map(({ scope, profileId, kind, status }) => ({ scope, profileId, kind, status })), [
      { scope: "legacy", profileId: null, kind: "repositories", status: "missing" },
      { scope: "legacy", profileId: null, kind: "datasets", status: "empty" },
      { scope: "profile", profileId: defaultId, kind: "repositories", status: "empty" },
      { scope: "profile", profileId: defaultId, kind: "datasets", status: "missing" },
      { scope: "profile", profileId: personalId, kind: "repositories", status: "empty" },
      { scope: "profile", profileId: personalId, kind: "datasets", status: "empty" },
    ]);
    assert.deepEqual(filesystemSnapshot(dataRoot), before);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("registered-profile approvals fail verification preflight without opening their targets", () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-profiles-")));
  const sentinelRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-verification-profile-target-")));
  const sentinel = join(sentinelRoot, "must-not-open.csv");
  const registry = openProfileRegistry({ managedRoot: dataRoot });
  const defaultId = "33333333-3333-4333-8333-333333333333";
  try {
    registry.initializeDefault({ profileId: defaultId });
    mkdirSync(registry.layout.profilesRoot, { mode: 0o700 });
    chmodSync(registry.layout.profilesRoot, 0o700);
    mkdirSync(registry.profileRoot(defaultId), { mode: 0o700 });
    chmodSync(registry.profileRoot(defaultId), 0o700);
    writeFileSync(join(registry.profileRoot(defaultId), "repositories.json"), `${JSON.stringify([{
      id: "outside", name: "outside", path: sentinelRoot, addedAt: "2026-08-13T00:00:00.000Z",
    }])}\n`, { mode: 0o600 });
    writeFileSync(sentinel, "private-sentinel\n", { mode: 0o600 });
    const oldTime = new Date("2001-01-01T00:00:00.000Z");
    utimesSync(sentinel, oldTime, oldTime);
    const beforeTarget = lstatSync(sentinel, { bigint: true });
    const beforeData = filesystemSnapshot(dataRoot);
    chmodSync(sentinel, 0o000);

    assert.throws(
      () => preflightVerificationExternalFilesystemRegistries({ dataRoot, environment: policyEnvironment }),
      /External filesystem access is disabled/,
    );
    const afterTarget = lstatSync(sentinel, { bigint: true });
    assert.equal(afterTarget.atimeNs, beforeTarget.atimeNs);
    assert.equal(afterTarget.mtimeNs, beforeTarget.mtimeNs);
    assert.equal(afterTarget.size, beforeTarget.size);
    assert.deepEqual(filesystemSnapshot(dataRoot), beforeData);
  } finally {
    try { chmodSync(sentinel, 0o600); } catch { /* fixture may not exist */ }
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(sentinelRoot, { recursive: true, force: true });
  }
});

test("verification launch uses a narrow child environment and normal launch remains unchanged", () => {
  const boundary = {
    artifactRoot: "/sealed/Contents/Resources",
    resourceRoot: "/sealed/Contents/Resources/rangabot-resources",
    dataRoot: "/synthetic/capsule/userData/private-data",
    tempRoot: "/synthetic/capsule/userData/private-data/tmp",
    serverEntrypoint: "/sealed/Contents/Resources/rangabot-resources/server.js",
    desktopManifestPath: "/sealed/Contents/Resources/rangabot-resources/desktop/manifest.json",
  } as const;
  const hostile = {
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    PATH: "/hostile/bin",
    HOME: "/Users/real-user",
    OLLAMA_BASE_URL: "http://127.0.0.1:29999",
    OLLAMA_MODEL: "private-model",
    [RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV]: VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
    [RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV]: VERIFICATION_LOCAL_MODEL_POLICY,
    OLLAMA_EMBED_MODEL: "private-embedding",
    RANGABOT_DATA_ROOT: "/forged",
    RANGABOT_PROFILE: "forged",
    NODE_OPTIONS: "--inspect",
    NODE_INSPECT_RESUME_ON_START: "1",
    HTTPS_PROXY: "http://proxy.invalid",
  };
  const verification = createDesktopLaunch({
    boundary,
    port: 43131,
    baseEnvironment: hostile,
    verificationPolicy: {
      externalFilesystemAccess: VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
      localModelPolicy: VERIFICATION_LOCAL_MODEL_POLICY,
    },
  });
  assert.equal(verification.environment.LANG, "en_US.UTF-8");
  assert.equal(verification.environment.TZ, "UTC");
  for (const key of [
    "PATH", "HOME", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_EMBED_MODEL", "NODE_OPTIONS",
    "NODE_INSPECT_RESUME_ON_START", "HTTPS_PROXY", "RANGABOT_PROFILE",
  ]) assert.equal(verification.environment[key], undefined, key);
  assert.equal(
    verification.environment[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV],
    VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  );
  assert.equal(verification.environment[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV], VERIFICATION_LOCAL_MODEL_POLICY);
  assert.equal(verification.environment.RANGABOT_DATA_ROOT, boundary.dataRoot);

  const normal = createDesktopLaunch({ boundary, port: 43132, baseEnvironment: hostile });
  assert.equal(normal.environment.PATH, "/hostile/bin");
  assert.equal(normal.environment.OLLAMA_MODEL, "private-model");
  assert.equal(normal.environment[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV], undefined);
  assert.equal(normal.environment[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV], undefined);
  assert.equal(verificationLocalModelDisabled(policyEnvironment), true);
});

test("verification local-model policy fails before any provider request", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("must not fetch"); }) as typeof fetch;
  try {
    const status = await withVerificationPolicy(() => getOllamaStatus());
    assert.equal(status.available, false);
    assert.match(status.error ?? "", /disabled in this sealed verification build/);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("verification local-model policy disables Knowledge embeddings before fetch", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches += 1; throw new Error("must not fetch"); }) as typeof fetch;
  try {
    assert.equal(await withVerificationPolicy(() => embedKnowledgeQuery("synthetic local query")), null);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("verification imports fail before API request bodies can be read", async () => {
  await withVerificationPolicy(() => {
    assert.throws(() => assertExternalImportAccess("conversation-import"), /External filesystem access is disabled/);
    assert.throws(() => assertExternalImportAccess("memory-import"), /External filesystem access is disabled/);
    assert.throws(() => assertExternalImportAccess("profile-backup-import"), /External filesystem access is disabled/);
    assert.throws(() => assertProfileBackupExportAccess(), /External filesystem access is disabled/);
  });
  const conversationRoute = readFileSync(new URL("../app/api/conversations/import/route.ts", import.meta.url), "utf8");
  const memoryRoute = readFileSync(new URL("../app/api/memories/import/route.ts", import.meta.url), "utf8");
  assert.ok(conversationRoute.indexOf("assertExternalImportAccess") < conversationRoute.indexOf("request.json()"));
  assert.ok(memoryRoute.lastIndexOf("assertExternalImportAccess") < memoryRoute.indexOf("const text = await readBoundedBody(request)"));
});
