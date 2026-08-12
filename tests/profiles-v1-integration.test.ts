import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { migrateLegacyDataToDefault } from "../lib/profile-migration.ts";

const defaultProfileId = "10000000-0000-4000-8000-000000000001";

function moduleUrl(path: string) {
  return pathToFileURL(resolve(path)).href;
}

function fixture(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

test("two active profiles isolate every implemented mutable domain while shared model storage remains unchanged", { timeout: 60_000 }, () => {
  const root = fixture("rangabot-profiles-v1-canary-");
  const managedRoot = join(root, "managed-data");
  const externalRoot = join(root, "synthetic-external");
  const repositoryRoot = join(externalRoot, "repository");
  const datasetPath = join(externalRoot, "rows.csv");
  mkdirSync(join(managedRoot, "models"), { recursive: true, mode: 0o700 });
  mkdirSync(repositoryRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(managedRoot, "models", "shared-weight.marker"), "shared-model-bytes\n", { mode: 0o600 });
  writeFileSync(join(managedRoot, "legacy-marker.txt"), "original-legacy-workspace\n", { mode: 0o600 });
  writeFileSync(join(repositoryRoot, "README.md"), "synthetic repository\n", { mode: 0o600 });
  writeFileSync(datasetPath, "profile,value\ndefault,1\npersonal,2\n", { mode: 0o600 });

  const source = String.raw`
    import assert from "node:assert/strict";
    import { createHash, randomUUID } from "node:crypto";
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { isAbsolute, join, relative } from "node:path";

    const runtimeModule = await import(${JSON.stringify(moduleUrl("lib/runtime-paths.ts"))});
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const operations = await import(${JSON.stringify(moduleUrl("lib/profile-operations.ts"))});
    const conversations = await import(${JSON.stringify(moduleUrl("lib/conversations.ts"))});
    const turns = await import(${JSON.stringify(moduleUrl("lib/conversation-turns.ts"))});
    const feedback = await import(${JSON.stringify(moduleUrl("lib/response-feedback.ts"))});
    const memories = await import(${JSON.stringify(moduleUrl("lib/memories.ts"))});
    const knowledge = await import(${JSON.stringify(moduleUrl("lib/knowledge.ts"))});
    const repositories = await import(${JSON.stringify(moduleUrl("lib/repositories.ts"))});
    const datasets = await import(${JSON.stringify(moduleUrl("lib/datasets.ts"))});
    const preferences = await import(${JSON.stringify(moduleUrl("lib/desktop-preferences.ts"))});
    const models = await import(${JSON.stringify(moduleUrl("lib/model-manager.ts"))});
    const confirmations = await import(${JSON.stringify(moduleUrl("lib/sql-confirmation-store.ts"))});
    const sessions = await import(${JSON.stringify(moduleUrl("lib/local-session-token.ts"))});
    const requests = await import(${JSON.stringify(moduleUrl("lib/profile-request.ts"))});
    const security = await import(${JSON.stringify(moduleUrl("lib/local-http-security.ts"))});
    const backupModule = await import(${JSON.stringify(moduleUrl("lib/profile-backup.ts"))});

    const paths = runtimeModule.runtimePaths;
    const sharedModelPath = join(paths.managedModels, "shared-weight.marker");
    const sharedBefore = createHash("sha256").update(readFileSync(sharedModelPath)).digest("hex");
    const originalLegacy = readFileSync(join(paths.managedDataRoot, "legacy-marker.txt"), "utf8");

    const initialized = lifecycle.initializeDefaultProfile({ confirmed: true });
    assert.equal(initialized.message, "Your existing workspace is ready in Default.");
    const defaultId = initialized.snapshot.activeProfileId;
    const defaultRoot = paths.dataRoot;
    assert.equal(readFileSync(join(defaultRoot, "legacy-marker.txt"), "utf8"), originalLegacy);
    assert.equal(readFileSync(join(paths.managedDataRoot, "legacy-marker.txt"), "utf8"), originalLegacy);
    assert.equal(existsSync(join(defaultRoot, "models")), false);

    function populate(label, modelId, candidate) {
      const started = turns.beginConversationTurn({
        id: randomUUID(),
        userMessage: { role: "user", content: label + " private question" },
        options: { mode: "local" },
      });
      turns.completeConversationTurn(started.turn.id, { role: "assistant", content: label + " private answer" }, candidate);
      const feedbackResult = feedback.setResponseFeedback(
        conversations.getConversationDatabase(),
        started.conversationId,
        started.turn.id,
        "helpful",
      );
      assert.equal(feedbackResult.kind, "updated");
      memories.createMemory(label + " private memory", "fact");
      knowledge.saveKnowledgeDocument({
        id: randomUUID(),
        path: "/synthetic/" + label + ".md",
        title: label + " private knowledge",
        format: "md",
        sizeBytes: 12,
        sha256: candidate,
        chunks: [{ id: randomUUID(), ordinal: 0, content: label + " knowledge chunk" }],
      });
      const repository = repositories.allowRepository(${JSON.stringify(repositoryRoot)});
      const dataset = datasets.approveDataset(${JSON.stringify(datasetPath)});
      preferences.updateDesktopPreferences({
        expectedRevision: 0,
        preferredName: label,
        welcomeMode: label === "Default" ? "quotes" : "books",
        appearance: label === "Default" ? "light" : "dark",
        palette: label === "Default" ? "moss" : "plum",
      }, { now: label === "Default" ? "2026-08-13T01:00:00.000Z" : "2026-08-13T02:00:00.000Z" });
      models.updateSelectedChatModel({ modelId, expectedRevision: 0 });
      mkdirSync(paths.artifactsRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(paths.artifactsRoot, label + ".marker"), label, { mode: 0o600 });
      confirmations.writeSqlConfirmationStore(paths.sqlConfirmations, [{
        id: randomUUID(),
        tokenHash: candidate,
        datasetId: dataset.id,
        datasetSha256: dataset.fileIdentity.sha256,
        query: "SELECT 1",
        querySha256: candidate,
        expiresAt: "2026-08-14T00:00:00.000Z",
      }]);
      return { conversationId: started.conversationId, repositoryId: repository.id, datasetId: dataset.id };
    }

    function snapshot(label) {
      return {
        root: paths.dataRoot,
        conversations: conversations.listConversations().map((item) => item.id),
        memories: memories.listMemories().map((item) => item.content),
        knowledge: knowledge.listIndexedKnowledgeDocuments().map((item) => item.title),
        repositories: repositories.listAllowedRepositories().map((item) => item.id),
        datasets: datasets.listApprovedDatasets().map((item) => item.id),
        preferredName: preferences.readDesktopPreferences().preferredName,
        selectedModel: models.readModelPreference().selectedModel,
        feedbackRows: Number((conversations.getConversationDatabase().prepare("SELECT COUNT(*) AS count FROM response_feedback").get()).count),
        artifact: readFileSync(join(paths.artifactsRoot, label + ".marker"), "utf8"),
        confirmations: JSON.parse(readFileSync(paths.sqlConfirmations, "utf8")).length,
      };
    }

    function routedMutablePaths() {
      return {
        conversationDatabase: paths.conversationDatabase,
        responseFeedbackDatabase: paths.responseFeedbackDatabase,
        memoryDatabase: paths.memoryDatabase,
        datasetsRegistry: paths.datasetsRegistry,
        repositoriesRegistry: paths.repositoriesRegistry,
        sqlConfirmations: paths.sqlConfirmations,
        datasetSnapshots: paths.datasetSnapshots,
        artifactsRoot: paths.artifactsRoot,
        desktopPreferences: paths.desktopPreferences,
        modelPreferences: paths.modelPreferences,
        knowledgeRoot: paths.knowledgeRoot,
        knowledgeInbox: paths.knowledgeInbox,
        knowledgeProcessed: paths.knowledgeProcessed,
        knowledgeIndexes: paths.knowledgeIndexes,
        knowledgeDatabase: paths.knowledgeDatabase,
        knowledgeBackups: paths.knowledgeBackups,
        knowledgeEvaluationResults: paths.knowledgeEvaluationResults,
        evaluationsRoot: paths.evaluationsRoot,
        evaluationResults: paths.evaluationResults,
      };
    }

    function assertRoutedInside(root, entries) {
      for (const [name, path] of Object.entries(entries)) {
        const child = relative(root, path);
        assert.equal(isAbsolute(child) || child === ".." || child.startsWith("../"), false, name + " escaped the active profile root");
      }
    }

    const defaultState = populate("Default", "qwen3:8b", "a".repeat(64));
    const afterDefault = snapshot("Default");
    const defaultMutablePaths = routedMutablePaths();
    assertRoutedInside(defaultRoot, defaultMutablePaths);
    assert.deepEqual(afterDefault.conversations, [defaultState.conversationId]);
    assert.deepEqual(afterDefault.memories, ["Default private memory"]);
    assert.deepEqual(afterDefault.knowledge, ["Default private knowledge"]);
    assert.deepEqual(afterDefault.repositories, [defaultState.repositoryId]);
    assert.deepEqual(afterDefault.datasets, [defaultState.datasetId]);
    assert.equal(afterDefault.preferredName, "Default");
    assert.equal(afterDefault.selectedModel, "qwen3:8b");
    assert.equal(afterDefault.feedbackRows, 1);

    const personalCreated = lifecycle.createProfile({
      displayName: "Private Work",
      kind: "personal",
      expectedGeneration: context.getProfileRegistry().read().generation,
    });
    const personalId = personalCreated.profile.id;
    const testingCreated = lifecycle.createProfile({
      displayName: "Canary",
      kind: "testing",
      expectedGeneration: personalCreated.snapshot.generation,
    });
    const testingId = testingCreated.profile.id;
    writeFileSync(join(context.getProfileRegistry().profileRoot(testingId), "reset-me.marker"), "temporary", { mode: 0o600 });

    const beforeSwitch = context.getProfileContext().binding;
    const secret = sessions.createLocalSessionSecret();
    const staleToken = sessions.issueLocalSessionToken(secret, beforeSwitch);
    const switched = lifecycle.switchProfile({
      profileId: personalId,
      expectedGeneration: testingCreated.snapshot.generation,
    });
    const personalRoot = paths.dataRoot;
    assert.notEqual(personalRoot, defaultRoot);
    const personalMutablePaths = routedMutablePaths();
    assertRoutedInside(personalRoot, personalMutablePaths);
    for (const name of Object.keys(defaultMutablePaths)) {
      assert.notEqual(personalMutablePaths[name], defaultMutablePaths[name], name + " retained the previous profile path");
    }
    assert.equal(paths.managedModels, join(paths.managedDataRoot, "models"));
    assert.equal(paths.runtimeLease, join(paths.managedDataRoot, "rangabot.db-runtime.lock"));
    assert.equal(paths.desktopTemp, join(paths.managedDataRoot, "tmp"));
    assert.deepEqual(conversations.listConversations(), []);
    assert.deepEqual(memories.listMemories(), []);
    assert.deepEqual(knowledge.listIndexedKnowledgeDocuments(), []);
    assert.deepEqual(repositories.listAllowedRepositories(), []);
    assert.deepEqual(datasets.listApprovedDatasets(), []);
    assert.equal(preferences.readDesktopPreferences().revision, 0);
    assert.equal(models.readModelPreference().revision, 0);
    assert.equal(sessions.verifyLocalSessionToken(staleToken, secret, context.getProfileContext().binding), false);
    assert.throws(() => context.assertProfileSessionBindingCurrent(beforeSwitch), /active profile changed/i);
    const staleRequest = new Request("http://127.0.0.1/api/memories", {
      headers: { [security.LOCAL_PROFILE_CONTEXT_HEADER]: sessions.localProfileSessionContext(beforeSwitch) },
    });
    assert.throws(() => requests.profileBindingFromRequest(staleRequest), /active profile changed/i);

    const personalState = populate("Personal", "gemma3:4b", "b".repeat(64));
    const afterPersonal = snapshot("Personal");
    assert.deepEqual(afterPersonal.conversations, [personalState.conversationId]);
    assert.deepEqual(afterPersonal.memories, ["Personal private memory"]);
    assert.deepEqual(afterPersonal.knowledge, ["Personal private knowledge"]);
    assert.deepEqual(afterPersonal.repositories, [personalState.repositoryId]);
    assert.deepEqual(afterPersonal.datasets, [personalState.datasetId]);
    assert.equal(afterPersonal.preferredName, "Personal");
    assert.equal(afterPersonal.selectedModel, "gemma3:4b");
    assert.equal(afterPersonal.feedbackRows, 1);

    for (const kind of operations.profileOperationKinds) {
      const handle = operations.profileOperations.begin({
        binding: context.getProfileContext().binding,
        kind,
        label: "Synthetic " + kind,
        cancellable: kind === "generation",
      });
      try {
        assert.throws(() => lifecycle.switchProfile({
          profileId: defaultId,
          expectedGeneration: context.getProfileRegistry().read().generation,
        }), (error) => error instanceof lifecycle.ProfileBusyError && error.operation.kind === kind);
      } finally {
        handle.release();
      }
    }

    const backToDefault = lifecycle.switchProfile({
      profileId: defaultId,
      expectedGeneration: context.getProfileRegistry().read().generation,
    });
    assert.deepEqual(snapshot("Default"), afterDefault);
    assert.equal(existsSync(join(defaultRoot, "Personal.marker")), false);
    assert.equal(existsSync(join(personalRoot, "Default.marker")), false);

    lifecycle.closeActiveProfileResources();
    const backup = await lifecycle.backupProfile(defaultId);
    const backupInspection = backupModule.inspectProfileBackup(backup);
    assert.equal(backupInspection.externalReferences, 2);
    const restored = lifecycle.restoreProfile({
      bytes: backup,
      displayName: "Restored Copy",
      kind: "personal",
      expectedGeneration: backToDefault.snapshot.generation,
    });
    const restoredRoot = context.getProfileRegistry().profileRoot(restored.profile.id);
    assert.equal(existsSync(join(restoredRoot, "repositories.json")), false);
    assert.equal(existsSync(join(restoredRoot, "datasets.json")), false);
    const inactive = JSON.parse(readFileSync(join(restoredRoot, backupModule.PROFILE_RESTORED_EXTERNAL_REFERENCES), "utf8"));
    assert.equal(inactive.status, "inactive-reapproval-required");
    assert.equal(inactive.references.length, 2);
    assert.ok(inactive.references.every((item) => item.status === "inactive-reapproval-required"));

    const reset = lifecycle.resetTestingProfile({
      profileId: testingId,
      expectedGeneration: restored.snapshot.generation,
      confirmedName: "Canary",
    });
    assert.equal(existsSync(join(context.getProfileRegistry().profileRoot(testingId), "reset-me.marker")), false);
    assert.throws(() => lifecycle.resetTestingProfile({
      profileId: testingId,
      expectedGeneration: reset.snapshot.generation,
      confirmedName: "wrong",
    }), /exact profile name/i);
    assert.throws(() => lifecycle.deleteProfile({
      profileId: defaultId,
      expectedGeneration: reset.snapshot.generation,
      confirmedName: "Default",
    }), /cannot be deleted/i);
    assert.throws(() => lifecycle.deleteProfile({
      profileId: personalId,
      expectedGeneration: reset.snapshot.generation,
      confirmedName: "wrong",
    }), /exact profile name/i);
    const removed = lifecycle.deleteProfile({
      profileId: personalId,
      expectedGeneration: reset.snapshot.generation,
      confirmedName: "Private Work",
    });
    assert.equal(removed.snapshot.profiles.some((profile) => profile.id === personalId), false);
    assert.equal(existsSync(personalRoot), false);

    const sharedAfter = createHash("sha256").update(readFileSync(sharedModelPath)).digest("hex");
    assert.equal(sharedAfter, sharedBefore);
    for (const profile of context.getProfileRegistry().read().profiles) {
      assert.equal(existsSync(join(context.getProfileRegistry().profileRoot(profile.id), "models")), false);
    }
    conversations.closeConversationDatabaseForTests();
    memories.closeMemoryDatabaseForTests();
    knowledge.closeKnowledgeDatabaseForTests();
    console.log(JSON.stringify({
      defaultId,
      testingId,
      restoredId: restored.profile.id,
      generation: removed.snapshot.generation,
      sharedModelSha256: sharedAfter,
      backupExternalReferences: backupInspection.externalReferences,
      operationKindsBlocked: operations.profileOperationKinds.length,
    }));
  `;

  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
      cwd: root,
      env: {
        ...process.env,
        RANGABOT_RESOURCE_ROOT: realpathSync(resolve(".")),
        RANGABOT_DATA_ROOT: managedRoot,
        KNOWLEDGE_DISABLE_EMBEDDINGS: "1",
      },
      encoding: "utf8",
      timeout: 55_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null") as {
      defaultId: string;
      testingId: string;
      restoredId: string;
      generation: number;
      sharedModelSha256: string;
      backupExternalReferences: number;
      operationKindsBlocked: number;
    };
    assert.match(result.defaultId, /^[0-9a-f-]{36}$/);
    assert.match(result.testingId, /^[0-9a-f-]{36}$/);
    assert.match(result.restoredId, /^[0-9a-f-]{36}$/);
    assert.ok(result.generation >= 8);
    assert.match(result.sharedModelSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.backupExternalReferences, 2);
    assert.equal(result.operationKindsBlocked, 13);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Default adoption rolls back copy failures and retains a recovery-owned root after ambiguous activation", () => {
  for (const failure of ["copy", "registry"] as const) {
    const managedRoot = fixture(`rangabot-profile-migration-${failure}-`);
    const profilesRoot = join(managedRoot, "profiles-v1", "data");
    const recoveryRoot = join(managedRoot, "profiles-v1", "recovery");
    const legacyPath = join(managedRoot, "legacy-private.marker");
    const sharedModelPath = join(managedRoot, "models", "shared-weight.marker");
    mkdirSync(join(managedRoot, "models"), { mode: 0o700 });
    writeFileSync(legacyPath, "legacy remains authoritative\n", { mode: 0o600 });
    writeFileSync(sharedModelPath, "shared bytes\n", { mode: 0o600 });
    const legacyBefore = readFileSync(legacyPath);
    const modelBefore = readFileSync(sharedModelPath);
    try {
      assert.throws(() => migrateLegacyDataToDefault({
        managedRoot,
        profilesRoot,
        recoveryRoot,
        profileId: defaultProfileId,
        ...(failure === "copy" ? {
          copyFile() {
            throw Object.assign(new Error("synthetic low space"), { code: "ENOSPC" });
          },
        } : {}),
        activateRegistry() {
          if (failure === "registry") throw new Error("synthetic registry cutover failure");
        },
      }), failure === "copy" ? /low space/ : /registry cutover failure/);
      assert.deepEqual(readFileSync(legacyPath), legacyBefore);
      assert.deepEqual(readFileSync(sharedModelPath), modelBefore);
      assert.equal(existsSync(join(profilesRoot, defaultProfileId)), failure === "registry");
      if (failure === "registry") {
        assert.deepEqual(readFileSync(join(profilesRoot, defaultProfileId, "legacy-private.marker")), legacyBefore);
      }
    } finally {
      rmSync(managedRoot, { recursive: true, force: true });
    }
  }
});
