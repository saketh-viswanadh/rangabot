import assert from "node:assert/strict";
import test from "node:test";
import { defaultKnowledgeDoctorTimeoutMs, getKnowledgeDoctorTimeoutMs, inspectKnowledgeFileHashes } from "../lib/knowledge-doctor.ts";

test("validates the bounded Knowledge Doctor timeout", () => {
  assert.equal(getKnowledgeDoctorTimeoutMs(), defaultKnowledgeDoctorTimeoutMs);
  assert.equal(getKnowledgeDoctorTimeoutMs("45000"), 45_000);
  assert.throws(() => getKnowledgeDoctorTimeoutMs("999"), /1000 to 300000/);
  assert.throws(() => getKnowledgeDoctorTimeoutMs("forever"), /1000 to 300000/);
});

test("returns an incomplete scan instead of hanging past its deadline", async () => {
  const result = await inspectKnowledgeFileHashes(["slow-book.pdf"], 5, async (_path, signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  assert.equal(result.complete, false);
  assert.deepEqual(result.files, []);
});

test("returns completed file signatures", async () => {
  const result = await inspectKnowledgeFileHashes(["a.txt", "b.txt"], 1_000, async (path) => `hash-${path}`);
  assert.deepEqual(result, { complete: true, files: [{ path: "a.txt", sha256: "hash-a.txt" }, { path: "b.txt", sha256: "hash-b.txt" }] });
});
