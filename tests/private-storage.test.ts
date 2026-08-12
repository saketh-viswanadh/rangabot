import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  hardenPrivateSqliteFiles,
  hardenPrivateTree,
  privateDirectoryMode,
  privateFileMode,
  supportsPosixPermissions,
  writePrivateJsonFileAtomic,
  writePrivateTextFileAtomic,
} from "../lib/private-storage.ts";
import { repairPrivateStorage } from "../scripts/repair-private-storage.ts";

function permissions(path: string) {
  return statSync(path).mode & 0o777;
}

function assertPrivatePermissions(path: string, expected: number) {
  if (supportsPosixPermissions()) assert.equal(permissions(path), expected);
}

test("private storage helpers repair only synthetic app-managed paths", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-private-storage-"));
  const directory = join(root, "nested");
  const file = join(directory, "private.json");
  const database = join(directory, "private.db");
  try {
    ensurePrivateDirectory(directory);
    closeSync(openSync(file, "w", 0o666));
    ensurePrivateFile(file);
    closeSync(openSync(database, "w", 0o666));
    closeSync(openSync(`${database}-wal`, "w", 0o666));
    closeSync(openSync(`${database}-shm`, "w", 0o666));
    if (supportsPosixPermissions()) {
      chmodSync(directory, 0o755);
      chmodSync(file, 0o644);
      chmodSync(database, 0o644);
      chmodSync(`${database}-wal`, 0o644);
      chmodSync(`${database}-shm`, 0o644);
    }
    ensurePrivateDirectory(directory);
    ensurePrivateFile(file);
    hardenPrivateSqliteFiles(database);
    assertPrivatePermissions(directory, privateDirectoryMode);
    for (const path of [file, database, `${database}-wal`, `${database}-shm`]) {
      assertPrivatePermissions(path, privateFileMode);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private tree repair is recursive and refuses symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-private-tree-"));
  const managed = join(root, "managed");
  const nested = join(managed, "nested");
  const file = join(nested, "result.json");
  try {
    ensurePrivateDirectory(nested);
    closeSync(openSync(file, "w", 0o666));
    if (supportsPosixPermissions()) {
      chmodSync(managed, 0o755);
      chmodSync(nested, 0o755);
      chmodSync(file, 0o644);
    }
    assert.deepEqual(hardenPrivateTree(managed), { directories: 2, files: 1 });
    assertPrivatePermissions(managed, privateDirectoryMode);
    assertPrivatePermissions(nested, privateDirectoryMode);
    assertPrivatePermissions(file, privateFileMode);
    if (supportsPosixPermissions()) {
      const link = join(root, "link");
      symlinkSync(managed, link);
      assert.throws(() => hardenPrivateTree(link), /refuses symbolic links/);
      const nestedLink = join(managed, "nested-link");
      symlinkSync(root, nestedLink);
      assert.deepEqual(hardenPrivateTree(managed, { skipNestedSymlinks: true }), { directories: 2, files: 1 });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all private storage operations reject an intermediate symlink below their trusted root", () => {
  if (!supportsPosixPermissions()) return;
  const root = mkdtempSync(join(tmpdir(), "rangabot-private-ancestor-link-"));
  const project = join(root, "project");
  const external = join(root, "external");
  const externalFile = join(external, "private.json");
  const linkedRoot = join(project, "managed");
  const linkedFile = join(linkedRoot, "private.json");
  try {
    mkdirSync(project);
    mkdirSync(external);
    closeSync(openSync(externalFile, "w", 0o644));
    chmodSync(external, 0o755);
    chmodSync(externalFile, 0o644);
    symlinkSync(external, linkedRoot);

    assert.throws(
      () => ensurePrivateDirectory(join(linkedRoot, "nested"), { trustedRoot: project }),
      /contains a symbolic link/,
    );
    assert.throws(
      () => ensurePrivateFile(linkedFile, { trustedRoot: project }),
      /contains a symbolic link/,
    );
    assert.throws(
      () => writePrivateJsonFileAtomic(linkedFile, { shouldNotWrite: true }, { trustedRoot: project }),
      /contains a symbolic link/,
    );
    assert.throws(
      () => hardenPrivateTree(linkedFile, { trustedRoot: project, skipNestedSymlinks: true }),
      /contains a symbolic link/,
    );

    const repair = repairPrivateStorage(project, ["managed/private.json"]);
    assert.deepEqual(repair, { directories: 0, files: 0, skippedPaths: ["managed/private.json"] });
    assert.equal(readFileSync(externalFile, "utf8"), "");
    assert.equal(existsSync(join(external, "nested")), false);
    assert.equal(permissions(external), 0o755);
    assert.equal(permissions(externalFile), 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private storage refuses hard-linked files without mutating the external inode", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-private-hardlink-"));
  const managed = join(root, "managed");
  const external = join(root, "external.txt");
  const linked = join(managed, "linked.txt");
  try {
    mkdirSync(managed, { mode: 0o700 });
    closeSync(openSync(external, "w", 0o644));
    linkSync(external, linked);
    const beforeMode = permissions(external);

    assert.throws(
      () => ensurePrivateFile(linked, { trustedRoot: managed }),
      /non-linked regular local file/,
    );
    assert.throws(
      () => writePrivateTextFileAtomic(linked, "must not replace\n", { trustedRoot: managed }),
      /non-linked regular local file/,
    );
    assert.throws(
      () => hardenPrivateTree(managed, { trustedRoot: managed }),
      /changed while it was being secured|non-linked regular local file/,
    );

    assert.equal(readFileSync(external, "utf8"), "");
    assert.equal(permissions(external), beforeMode);
    assert.equal(lstatSync(external).nlink, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private atomic writers replace synthetic results with owner-only files and no residue", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-private-writer-"));
  const directory = join(root, "results");
  const textPath = join(directory, "result.txt");
  const jsonPath = join(directory, "result.json");
  try {
    ensurePrivateDirectory(directory);
    closeSync(openSync(textPath, "w", 0o666));
    if (supportsPosixPermissions()) {
      chmodSync(directory, 0o755);
      chmodSync(textPath, 0o644);
    }

    writePrivateTextFileAtomic(textPath, "private synthetic result\n");
    writePrivateJsonFileAtomic(jsonPath, { synthetic: true, cases: 2 });

    assert.equal(readFileSync(textPath, "utf8"), "private synthetic result\n");
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), { synthetic: true, cases: 2 });
    assertPrivatePermissions(directory, privateDirectoryMode);
    assertPrivatePermissions(textPath, privateFileMode);
    assertPrivatePermissions(jsonPath, privateFileMode);
    assert.deepEqual(readdirSync(directory).sort(), ["result.json", "result.txt"]);

    if (supportsPosixPermissions()) {
      const external = join(root, "external.txt");
      const link = join(directory, "linked-result.json");
      closeSync(openSync(external, "w", 0o600));
      symlinkSync(external, link);
      assert.throws(() => writePrivateJsonFileAtomic(link, { shouldNotWrite: true }), /symbolic link/);
      assert.equal(readFileSync(external, "utf8"), "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation, memory, and knowledge databases enable secure deletion and private modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-private-databases-"));
  const conversationPath = join(root, "conversation", "rangabot.db");
  const memoryPath = join(root, "memory", "rangabot-memory.db");
  const knowledgePath = join(root, "knowledge", "knowledge.db");
  const conversations = await import("../lib/conversations.ts");
  const memories = await import("../lib/memories.ts");
  process.env.KNOWLEDGE_DISABLE_EMBEDDINGS = "1";
  const knowledge = await import("../lib/knowledge.ts");
  try {
    conversations.setConversationDatabasePathForTests(conversationPath);
    conversations.getConversationDatabase();
    memories.setMemoryDatabasePathForTests(memoryPath);
    memories.listMemories();
    knowledge.setKnowledgeDatabasePathForTests(knowledgePath);
    knowledge.saveKnowledgeDocument({
      id: randomUUID(),
      path: "/synthetic/private/lesson.txt",
      title: "Synthetic lesson",
      format: "txt",
      sizeBytes: 24,
      sha256: "synthetic-storage-test",
      chunks: [],
    });

    const activeDatabases = [
      conversations.getConversationDatabase(),
      memories.getMemoryDatabaseForTests(),
      knowledge.getKnowledgeDatabaseForTests(),
    ];
    for (const database of activeDatabases) {
      const row = database.prepare("PRAGMA secure_delete").get() as { secure_delete: number };
      assert.equal(row.secure_delete, 1);
    }
    for (const path of [conversationPath, memoryPath, knowledgePath]) {
      assertPrivatePermissions(join(path, ".."), privateDirectoryMode);
      assertPrivatePermissions(path, privateFileMode);
      for (const suffix of ["-wal", "-shm"]) {
        assertPrivatePermissions(`${path}${suffix}`, privateFileMode);
      }
    }
  } finally {
    conversations.closeConversationDatabaseForTests();
    memories.closeMemoryDatabaseForTests();
    knowledge.closeKnowledgeDatabaseForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
