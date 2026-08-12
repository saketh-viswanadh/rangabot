import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import {
  RANGABOT_DATA_ROOT_ENV,
  RANGABOT_RESOURCE_ROOT_ENV,
  resolveRuntimePathContract,
  resolveRuntimePathWithinRoot,
  RuntimePathError,
} from "../lib/runtime-paths.ts";

function fixture(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const resourceRoot = join(root, "resources");
  const dataRoot = join(root, "private-data");
  const unrelatedCwd = join(root, "unrelated-cwd");
  mkdirSync(resourceRoot);
  mkdirSync(dataRoot);
  mkdirSync(unrelatedCwd);
  return { root, resourceRoot, dataRoot, unrelatedCwd };
}

function configured(resourceRoot: string, dataRoot: string) {
  return {
    [RANGABOT_RESOURCE_ROOT_ENV]: resourceRoot,
    [RANGABOT_DATA_ROOT_ENV]: dataRoot,
  };
}

test("maps CLI roots compatibly without creating or importing any data", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-runtime-cli-")));
  try {
    const contract = resolveRuntimePathContract({ cwd: root, environment: {} });
    assert.equal(contract.mode, "cli");
    assert.equal(contract.resourceRoot, root);
    assert.equal(contract.dataRoot, join(root, "data"));
    assert.equal(contract.conversationDatabase, join(root, "data", "rangabot.db"));
    assert.equal(contract.responseFeedbackDatabase, contract.conversationDatabase);
    assert.equal(existsSync(contract.dataRoot), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires two separate absolute configured roots and rejects traversal", () => {
  const { root, resourceRoot, dataRoot } = fixture("rangabot-runtime-contract-");
  try {
    const contract = resolveRuntimePathContract({
      cwd: root,
      environment: configured(resourceRoot, dataRoot),
    });
    assert.equal(contract.mode, "configured");
    assert.equal(contract.resourceRoot, resourceRoot);
    assert.equal(contract.dataRoot, dataRoot);
    assert.equal(contract.packageJson, join(resourceRoot, "package.json"));
    assert.equal(contract.memoryDatabase, join(dataRoot, "rangabot-memory.db"));
    assert.equal(contract.knowledgeSourceManifest, join(resourceRoot, "data", "knowledge", "SOURCE_MANIFEST.json"));
    assert.equal(contract.knowledgeDatabase, join(dataRoot, "knowledge", "indexes", "knowledge.db"));

    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: { [RANGABOT_RESOURCE_ROOT_ENV]: resourceRoot } }),
      /must be supplied together/,
    );
    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: configured("relative/resources", dataRoot) }),
      /must be an absolute path/,
    );
    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: configured(`${resourceRoot}/../resources`, dataRoot) }),
      /must not contain parent traversal/,
    );
    const missingDataRoot = join(root, "not-created-by-contract");
    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: configured(resourceRoot, missingDataRoot) }),
      /must already exist/,
    );
    assert.equal(existsSync(missingDataRoot), false);
    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: configured(resourceRoot, join(resourceRoot, "data")) }),
      /must already exist|must not overlap/,
    );
    assert.throws(() => resolveRuntimePathWithinRoot(dataRoot, ".."), RuntimePathError);
    assert.throws(() => resolveRuntimePathWithinRoot(dataRoot, "knowledge/indexes"), RuntimePathError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects symbolic-link roots and existing symbolic-link path escapes", { skip: process.platform === "win32" }, () => {
  const { root, resourceRoot, dataRoot } = fixture("rangabot-runtime-symlink-");
  const resourceLink = join(root, "resource-link");
  const external = join(root, "external");
  try {
    mkdirSync(external);
    symlinkSync(resourceRoot, resourceLink);
    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: configured(resourceLink, dataRoot) }),
      /symbolic links/,
    );
    symlinkSync(external, join(dataRoot, "knowledge"));
    assert.throws(
      () => resolveRuntimePathContract({ cwd: root, environment: configured(resourceRoot, dataRoot) }),
      /symbolic links/,
    );
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a configured root reached through an intermediate symbolic-link ancestor", { skip: process.platform === "win32" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-runtime-ancestor-link-")));
  const realParent = join(root, "real-parent");
  const linkedParent = join(root, "linked-parent");
  const resourceRoot = join(realParent, "resources");
  const dataRoot = join(root, "private-data");
  try {
    mkdirSync(resourceRoot, { recursive: true });
    mkdirSync(dataRoot);
    symlinkSync(realParent, linkedParent);
    assert.throws(
      () => resolveRuntimePathContract({
        cwd: root,
        environment: configured(join(linkedParent, "resources"), dataRoot),
      }),
      /symbolic links/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selecting a desktop data root never auto-migrates, deletes, or backfills legacy data", () => {
  const { root, resourceRoot, dataRoot } = fixture("rangabot-runtime-no-migration-");
  const legacyData = join(resourceRoot, "data");
  const legacyDatabase = join(legacyData, "rangabot.db");
  try {
    mkdirSync(legacyData);
    writeFileSync(legacyDatabase, "synthetic legacy marker\n", { mode: 0o600 });
    const before = readFileSync(legacyDatabase, "utf8");
    const contract = resolveRuntimePathContract({ cwd: root, environment: configured(resourceRoot, dataRoot) });
    assert.equal(contract.conversationDatabase, join(dataRoot, "rangabot.db"));
    assert.equal(readFileSync(legacyDatabase, "utf8"), before);
    assert.deepEqual(readdirSync(dataRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function tree(path: string, prefix = ""): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [name, ...tree(join(path, entry.name), name)] : [name];
  }).sort();
}

test("configured runtime works from an unrelated cwd with read-only resources and data-only writes", { skip: process.platform === "win32" }, () => {
  const { root, resourceRoot, dataRoot, unrelatedCwd } = fixture("rangabot-runtime-integration-");
  const resourceLib = join(resourceRoot, "lib");
  const legacyResourceData = join(resourceRoot, "data");
  const legacyResourceDatabase = join(legacyResourceData, "rangabot.db");
  const datasetPath = join(root, "synthetic.csv");
  const repositoryPath = join(root, "synthetic-repository");
  mkdirSync(resourceLib);
  mkdirSync(legacyResourceData);
  mkdirSync(repositoryPath);
  writeFileSync(join(resourceRoot, "package.json"), "{}\n", { mode: 0o444 });
  writeFileSync(join(resourceLib, "sql-runtime-worker.cjs"), "// synthetic packaged worker\n", { mode: 0o444 });
  writeFileSync(legacyResourceDatabase, "synthetic legacy database marker\n", { mode: 0o444 });
  writeFileSync(datasetPath, "value\n1\n", { mode: 0o600 });
  writeFileSync(join(repositoryPath, "keep.txt"), "synthetic\n", { mode: 0o600 });
  const resourceBefore = tree(resourceRoot);
  chmodSync(resourceLib, 0o555);
  chmodSync(legacyResourceData, 0o555);
  chmodSync(resourceRoot, 0o555);

  const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href;
  const source = `
    const { readFileSync } = await import("node:fs");
    const pathsModule = await import(${JSON.stringify(moduleUrl("lib/runtime-paths.ts"))});
    const conversations = await import(${JSON.stringify(moduleUrl("lib/conversations.ts"))});
    const memories = await import(${JSON.stringify(moduleUrl("lib/memories.ts"))});
    const knowledge = await import(${JSON.stringify(moduleUrl("lib/knowledge.ts"))});
    const datasets = await import(${JSON.stringify(moduleUrl("lib/datasets.ts"))});
    const repositories = await import(${JSON.stringify(moduleUrl("lib/repositories.ts"))});
    const confirmations = await import(${JSON.stringify(moduleUrl("lib/sql-confirmation-store.ts"))});
    const leases = await import(${JSON.stringify(moduleUrl("lib/runtime-lease.ts"))});
    const storage = await import(${JSON.stringify(moduleUrl("lib/private-storage.ts"))});
    const paths = pathsModule.runtimePaths;
    if (paths.resourceRoot !== ${JSON.stringify(resourceRoot)} || paths.dataRoot !== ${JSON.stringify(dataRoot)}) throw new Error("root mismatch");
    if (paths.responseFeedbackDatabase !== paths.conversationDatabase) throw new Error("feedback storage split");
    if (readFileSync(paths.packageJson, "utf8") !== "{}\\n") throw new Error("packaged metadata unreadable");
    if (!readFileSync(paths.sqlRuntimeWorker, "utf8").includes("packaged worker")) throw new Error("packaged worker unreadable");
    let resourceWriteRejected = false;
    try { storage.ensurePrivateFile(pathsModule.runtimeResourcePath("forbidden.txt")); }
    catch { resourceWriteRejected = true; }
    if (!resourceWriteRejected) throw new Error("resource write was not rejected");
    conversations.getConversationDatabase();
    memories.createMemory("Synthetic desktop preference", "preference");
    knowledge.getKnowledgeStatus();
    datasets.approveDataset(${JSON.stringify(datasetPath)});
    repositories.allowRepository(${JSON.stringify(repositoryPath)});
    confirmations.writeSqlConfirmationStore(confirmations.defaultSqlConfirmationStorePath, []);
    storage.ensurePrivateDirectory(paths.artifactsRoot);
    const lease = leases.acquireRuntimeLease({ role: "app", inspectProcess: () => "alive" });
    lease.release();
    conversations.closeConversationDatabaseForTests();
    memories.closeMemoryDatabaseForTests();
    knowledge.closeKnowledgeDatabaseForTests();
  `;
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
      cwd: unrelatedCwd,
      env: { ...process.env, ...configured(resourceRoot, dataRoot), KNOWLEDGE_DISABLE_EMBEDDINGS: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(tree(resourceRoot), resourceBefore);
    assert.equal(readFileSync(legacyResourceDatabase, "utf8"), "synthetic legacy database marker\n");
    assert.deepEqual(readdirSync(unrelatedCwd), []);
    for (const path of [
      "rangabot.db",
      "rangabot-memory.db",
      "datasets.json",
      "repositories.json",
      "sql-confirmations.json",
      "artifacts",
      "knowledge",
    ]) assert.equal(existsSync(join(dataRoot, path)), true, `${path} must resolve under DATA_ROOT`);
    assert.equal(existsSync(join(dataRoot, "rangabot.db-runtime.lock")), false);
    assert.equal(lstatSync(dataRoot).isDirectory(), true);
  } finally {
    chmodSync(resourceLib, 0o700);
    chmodSync(legacyResourceData, 0o700);
    chmodSync(resourceRoot, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaging-critical consumers use the centralized resource or data path binding", () => {
  const bindings = new Map<string, RegExp>([
    ["lib/conversations.ts", /runtimePaths\.conversationDatabase/],
    ["lib/memories.ts", /runtimePaths\.memoryDatabase/],
    ["lib/knowledge.ts", /runtimePaths\.knowledgeDatabase/],
    ["lib/knowledge-welcome.ts", /runtimePaths\.knowledgeDatabase/],
    ["lib/datasets.ts", /runtimePaths\.datasetsRegistry/],
    ["lib/repositories.ts", /runtimePaths\.repositoriesRegistry/],
    ["lib/sql-confirmation-store.ts", /runtimePaths\.sqlConfirmations/],
    ["lib/conversation-artifacts.ts", /runtimePaths\.artifactsRoot/],
    ["lib/word-documents.ts", /runtimePaths\.artifactsRoot/],
    ["lib/runtime-lease.ts", /runtimePaths\.runtimeLease/],
    ["lib/sql-runtime.ts", /runtimePaths\.sqlRuntimeWorker/],
  ]);
  for (const [path, binding] of bindings) {
    const source = readFileSync(path, "utf8");
    assert.match(source, binding, path);
    assert.doesNotMatch(source, /process\.cwd\(\).*data/, path);
  }
  assert.match(readFileSync("lib/sql-runtime.ts", "utf8"), /createRequire\(runtimePaths\.packageJson\)/);
  for (const path of ["lib/conversations.ts", "lib/memories.ts", "lib/knowledge.ts"]) {
    assert.match(readFileSync(path, "utf8"), /createRequire\(runtimePaths\.packageJson\)/, path);
  }
});

function runtimeSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name === "out") return [];
    if (entry.isDirectory()) return runtimeSourceFiles(path);
    return /\.(?:ts|tsx|cjs|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test("production runtime has no unclassified cwd or relative data filesystem lookup", () => {
  const files = [
    ...runtimeSourceFiles("lib"),
    ...runtimeSourceFiles("app"),
    ...(existsSync("desktop") ? runtimeSourceFiles("desktop") : []),
    "proxy.ts",
    "next.config.ts",
    "scripts/start-dev.ts",
    "scripts/start-server.ts",
    "scripts/build.ts",
    "scripts/setup.ts",
    "scripts/doctor.ts",
    "scripts/repair-private-storage.ts",
  ].sort();
  const allowedCwdCounts = new Map<string, number>([
    ["lib/runtime-paths.ts", 1],
    ["lib/private-storage.ts", 1],
    // Candidate source/build identity intentionally accepts an explicit root
    // and retains project-cwd defaults for developer and build tooling. The
    // installed desktop identity flow is owned separately by its manifest.
    ["lib/response-feedback-candidate.ts", 4],
  ]);
  const pathCalls = new Set([
    "resolve", "join", "readFileSync", "writeFileSync", "existsSync", "readdirSync", "statSync",
    "lstatSync", "openSync", "mkdirSync", "rmSync", "renameSync", "ensurePrivateDirectory", "ensurePrivateFile",
  ]);
  const stringValues = (root: ts.Node) => {
    const values: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) values.push(node.text);
      else if (ts.isTemplateExpression(node)) values.push(node.head.text);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return values;
  };
  const relativeData = (value: string) => /^(?:\.[/\\])?data(?:[/\\]|$)/.test(value);

  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".cjs") || path.endsWith(".mjs")
      ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    let cwdCount = 0;
    const unclassifiedData: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          && expression.expression.text === "process" && expression.name.text === "cwd") cwdCount += 1;
        const callName = ts.isIdentifier(expression) ? expression.text
          : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
        if (pathCalls.has(callName)) {
          const argumentsToInspect = callName === "resolve" || callName === "join"
            ? node.arguments : node.arguments.slice(0, 1);
          for (const value of argumentsToInspect.flatMap(stringValues)) {
            if (relativeData(value)) unclassifiedData.push(`${callName}(${JSON.stringify(value)})`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.equal(cwdCount, allowedCwdCounts.get(path) ?? 0, `${path} has an unclassified process.cwd() lookup`);
    assert.deepEqual(unclassifiedData, [], `${path} has an unclassified relative data filesystem lookup`);
  }
  for (const path of allowedCwdCounts.keys()) assert.equal(files.includes(path), true, `${path} inventory entry is stale`);
});
