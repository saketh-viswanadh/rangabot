import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  importKnowledgeDocuments,
  KnowledgeImportError,
  preflightKnowledgeImport,
} from "../lib/knowledge-import.ts";
import { knowledgeImportFailureMessage, knowledgeImportMessage } from "../lib/knowledge-import-message.ts";

const mainPage = readFileSync("app/page.tsx", "utf8");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-knowledge-import-")));
  const inbox = join(root, "inbox");
  mkdirSync(inbox, { mode: 0o700 });
  return { root, inbox };
}

test("preflights every selection before copying when a later file is invalid", () => {
  const { root, inbox } = fixture();
  try {
    const valid = join(root, "valid.txt");
    const invalid = join(root, "invalid.exe");
    writeFileSync(valid, "valid synthetic text", { mode: 0o644 });
    writeFileSync(invalid, "invalid synthetic text", { mode: 0o644 });
    assert.throws(() => preflightKnowledgeImport([valid, invalid], inbox), (error) => (
      error instanceof KnowledgeImportError && error.phase === "preflight" && /No selected document was copied/.test(error.message)
    ));
    assert.deepEqual(readdirSync(inbox), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects selected-name and existing-destination collisions before any copy", () => {
  const { root, inbox } = fixture();
  try {
    const firstRoot = join(root, "one");
    const secondRoot = join(root, "two");
    mkdirSync(firstRoot); mkdirSync(secondRoot);
    const first = join(firstRoot, "book.txt");
    const second = join(secondRoot, "book.txt");
    writeFileSync(first, "first", { mode: 0o644 });
    writeFileSync(second, "second", { mode: 0o644 });
    assert.throws(() => preflightKnowledgeImport([first, second], inbox), /conflicts with another selected filename/);
    assert.deepEqual(readdirSync(inbox), []);
    writeFileSync(join(inbox, "book.txt"), "existing", { mode: 0o600 });
    assert.throws(() => preflightKnowledgeImport([first], inbox), /already exists in Knowledge/);
    assert.equal(readFileSync(join(inbox, "book.txt"), "utf8"), "existing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normalizes a public source copy to owner-private 0600 before ingestion", { skip: process.platform === "win32" }, async () => {
  const { root, inbox } = fixture();
  try {
    const source = join(root, "public-source.txt");
    writeFileSync(source, "synthetic source", { mode: 0o644 });
    chmodSync(source, 0o644);
    let observedMode = -1;
    const result = await importKnowledgeDocuments({
      paths: [source],
      knowledgeInbox: inbox,
      async ingest() {
        observedMode = lstatSync(join(inbox, "public-source.txt")).mode & 0o777;
        return { incompatible: 0, pending: 0 };
      },
    });
    assert.equal(observedMode, 0o600);
    assert.equal(lstatSync(join(inbox, "public-source.txt")).mode & 0o777, 0o600);
    assert.deepEqual(result.outcomes, [{ name: "public-source.txt", status: "copied-private" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an ingestion failure reports retained partial state instead of claiming nothing imported", async () => {
  const { root, inbox } = fixture();
  try {
    const first = join(root, "first.txt");
    const second = join(root, "second.md");
    writeFileSync(first, "first synthetic document", { mode: 0o644 });
    writeFileSync(second, "second synthetic document", { mode: 0o644 });
    await assert.rejects(
      importKnowledgeDocuments({
        paths: [first, second],
        knowledgeInbox: inbox,
        async ingest() { throw new Error("synthetic ingestion failure"); },
      }),
      (error) => error instanceof KnowledgeImportError
        && error.phase === "ingest"
        && error.copied === 2
        && error.retained.length === 2
        && /retained/.test(error.message)
        && /before assuming they are searchable/.test(error.message),
    );
    assert.equal(existsSync(join(inbox, "first.txt")), true);
    assert.equal(existsSync(join(inbox, "second.md")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a later copy failure rolls back every earlier new private copy", async () => {
  const { root, inbox } = fixture();
  try {
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    writeFileSync(first, "first", { mode: 0o644 });
    writeFileSync(second, "second", { mode: 0o644 });
    let copies = 0;
    await assert.rejects(importKnowledgeDocuments({
      paths: [first, second],
      knowledgeInbox: inbox,
      async ingest() { throw new Error("must not ingest"); },
      operations: {
        copy(source, destination) {
          copies += 1;
          if (copies === 2) throw new Error("synthetic later copy failure");
          copyFileSync(source, destination);
        },
      },
    }), (error) => error instanceof KnowledgeImportError
      && error.phase === "copy"
      && error.retained.length === 0
      && /rolled back/.test(error.message));
    assert.deepEqual(readdirSync(inbox), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed rollback reports the exact retained partial copy", async () => {
  const { root, inbox } = fixture();
  try {
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    writeFileSync(first, "first", { mode: 0o644 });
    writeFileSync(second, "second", { mode: 0o644 });
    let copies = 0;
    await assert.rejects(importKnowledgeDocuments({
      paths: [first, second],
      knowledgeInbox: inbox,
      async ingest() { throw new Error("must not ingest"); },
      operations: {
        copy(source, destination) {
          copies += 1;
          if (copies === 2) throw new Error("synthetic later copy failure");
          copyFileSync(source, destination);
        },
        unlink() { throw new Error("synthetic rollback failure"); },
      },
    }), (error) => error instanceof KnowledgeImportError
      && error.phase === "copy"
      && error.retained.length === 1
      && error.retained[0] === "first.txt"
      && /copy remains/.test(error.message));
    assert.equal(existsSync(join(inbox, "first.txt")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a private-mode normalization failure leaves no insecure Knowledge copy", async () => {
  const { root, inbox } = fixture();
  try {
    const source = join(root, "private.txt");
    writeFileSync(source, "private", { mode: 0o644 });
    await assert.rejects(importKnowledgeDocuments({
      paths: [source],
      knowledgeInbox: inbox,
      async ingest() { throw new Error("must not ingest"); },
      operations: { chmodPrivate() { throw new Error("synthetic chmod failure"); } },
    }), (error) => error instanceof KnowledgeImportError && error.phase === "copy" && error.retained.length === 0);
    assert.deepEqual(readdirSync(inbox), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("incompatible or pending sources use conservative imported-not-indexed wording", () => {
  const clean = knowledgeImportMessage({ selected: 1, copied: 1, incompatible: 0, pending: 0 });
  assert.match(clean, /Imported 1 selection into Knowledge/);
  assert.doesNotMatch(clean, /indexed|searchable/);
  const incompatible = knowledgeImportMessage({ selected: 1, copied: 1, incompatible: 1, pending: 0 });
  assert.match(incompatible, /some may not be searchable/);
  const pending = knowledgeImportMessage({ selected: 2, copied: 2, incompatible: 0, pending: 1 });
  assert.match(pending, /source needing attention/);
  assert.equal(knowledgeImportFailureMessage({ partial: true, retained: ["one.txt"] }),
    "1 selected document remains in Knowledge, but local processing may not have finished.");
  assert.equal(knowledgeImportFailureMessage({ error: "Exact retained-state evidence.", partial: true, retained: ["one.txt"] }),
    "Exact retained-state evidence.");
});

test("the main Knowledge panel preserves partial evidence and uses the shared conservative result formatter", () => {
  assert.match(mainPage, /knowledgeImportFailureMessage as formatKnowledgeImportFailureMessage,[\s\S]*knowledgeImportMessage as formatKnowledgeImportMessage/);
  assert.match(mainPage, /partial\?: boolean;[\s\S]*status\?: \{ incompatible\?: number; pending\?: number \}/);
  assert.match(mainPage, /if \(data\.partial\) \{[\s\S]*setKnowledgeImportPaths\(\[\]\);[\s\S]*await refreshKnowledge\(\);/);
  assert.match(mainPage, /setKnowledgeImportMessage\(formatKnowledgeImportFailureMessage\(data\)\)/);
  assert.match(mainPage, /setKnowledgeImportMessage\(formatKnowledgeImportMessage\(\{[\s\S]*selected: data\.selected \?\? knowledgeImportPaths\.length,[\s\S]*incompatible: data\.status\?\.incompatible,[\s\S]*pending: data\.status\?\.pending/);
  assert.doesNotMatch(mainPage, /added to this profile and indexed locally/);
  assert.match(mainPage, /knowledgeImporting \? "Importing…"/);
});
