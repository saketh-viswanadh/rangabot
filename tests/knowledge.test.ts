import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { chunkHierarchicalText } from "../lib/knowledge-ingestion.ts";

process.env.KNOWLEDGE_DISABLE_EMBEDDINGS = "1";
const knowledge = await import("../lib/knowledge.ts");
const testDatabase = resolve("data/knowledge-test.db");
knowledge.setKnowledgeDatabasePathForTests(testDatabase);

test.after(() => {
  knowledge.closeKnowledgeDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
});

test("indexes and retrieves a cited local teaching passage", async () => {
  knowledge.saveKnowledgeDocument({
    id: randomUUID(), path: "/private/local/python.txt", title: "Python lesson", format: "txt", sizeBytes: 100, sha256: "test-hash",
    chunks: [{ id: randomUUID(), ordinal: 1, content: "Python handles runtime errors with try and except clauses.", heading: "Handling errors", sectionPath: "Python basics > Handling errors", pageStart: 12, pageEnd: 13 }],
  });
  const results = await knowledge.searchKnowledge("Python runtime exceptions", 3);
  assert.equal(results[0]?.title, "Python lesson");
  assert.equal(results[0]?.chunk, 1);
  assert.match(results[0]?.content ?? "", /try and except/);
  assert.equal(results[0]?.sectionPath, "Python basics > Handling errors");
  assert.equal(results[0]?.pageStart, 12);
  assert.equal(knowledge.existingDocumentIngestionVersion("/private/local/python.txt"), knowledge.knowledgeIngestionVersion);
});

test("preserves heading hierarchy and page ranges while chunking", () => {
  const text = `[Page 4]\n# Statistics\n## Regression\n${"Regression estimates relationships between variables. ".repeat(8)}\n\n[Page 5]\n### Assumptions\n${"Residual assumptions affect inference and diagnostics. ".repeat(8)}`;
  const chunks = chunkHierarchicalText(text, 320, 40);
  assert.equal(chunks[0]?.sectionPath, "Statistics > Regression");
  assert.equal(chunks[0]?.pageStart, 4);
  assert.equal(chunks.some((chunk) => chunk.sectionPath === "Statistics > Regression > Assumptions" && chunk.pageStart === 5), true);
});

test("cleans conversational filler and keeps retrieval on the requested subject", async () => {
  knowledge.saveKnowledgeDocument({
    id: randomUUID(), path: "/private/local/ramayana.pdf", title: "Valmiki Ramayana", format: "pdf", sizeBytes: 200, sha256: "ramayana-hash",
    chunks: [{ id: randomUUID(), ordinal: 1, content: "The Ramayana tells of Rama, Sita, Lakshmana, Bharata, Hanuman, exile in the forest, and the journey to Lanka." }],
  });
  knowledge.saveKnowledgeDocument({
    id: randomUUID(), path: "/private/local/egypt.txt", title: "Ancient Egyptian mythology", format: "txt", sizeBytes: 100, sha256: "egypt-hash",
    chunks: [{ id: randomUUID(), ordinal: 1, content: "Osiris, Isis, Horus, and Set appear in ancient Egyptian mythology." }],
  });
  assert.deepEqual(knowledge.knowledgeQueryTerms("Please tell me all about the Ramayana"), ["ramayana"]);
  const ramayana = await knowledge.searchKnowledge("tell me about ramayana", 5);
  assert.equal(ramayana[0]?.title, "Valmiki Ramayana");
  assert.equal(ramayana.some((result) => /Python/i.test(result.title)), false);
  const egypt = await knowledge.searchKnowledge("explain Egyptian mythology", 5);
  assert.equal(egypt[0]?.title, "Ancient Egyptian mythology");
  assert.equal(egypt.some((result) => /Ramayana|Python/i.test(result.title)), false);
});

test("diversifies strong evidence across books without admitting weak sources", () => {
  const candidates = [
    { title: "Book A", path: "/a", chunk: 1, content: "A1", score: 1 },
    { title: "Book A", path: "/a", chunk: 2, content: "A2", score: .96 },
    { title: "Book A", path: "/a", chunk: 3, content: "A3", score: .93 },
    { title: "Book B", path: "/b", chunk: 1, content: "B1", score: .88 },
    { title: "Book C", path: "/c", chunk: 1, content: "C1", score: .45 },
  ];
  const results = knowledge.diversifyKnowledgeResults(candidates, 3);
  assert.deepEqual(results.map((result) => result.title), ["Book A", "Book B", "Book A"]);
  assert.equal(results.some((result) => result.title === "Book C"), false);
});

test("rejects clearly cross-subject books while retaining uncategorized sources", () => {
  const candidates = [
    { title: "Scikit-learn user guide", path: "/ml", chunk: 1, content: "Clustering metrics", score: 1 },
    { title: "Fluent Python", path: "/python", chunk: 1, content: "Object evaluation", score: .9 },
    { title: "Research notes", path: "/notes", chunk: 1, content: "Clustering evaluation", score: .8 },
  ];
  const filtered = knowledge.filterKnowledgeResultsBySubject("compare clustering evaluation methods", candidates);
  assert.deepEqual(filtered.map((result) => result.title), ["Scikit-learn user guide", "Research notes"]);
  assert.deepEqual(knowledge.inferKnowledgeSubjects("compare Greek and Egyptian creation myths"), ["greek-mythology", "egyptian-mythology"]);
});

test("relinks moved sources by content hash without duplicating their chunks", () => {
  const moved = knowledge.relinkKnowledgeDocumentByHash({ path: "/new/vault/ramayana.pdf", title: "Valmiki Ramayana", format: "pdf", sizeBytes: 200, sha256: "ramayana-hash" });
  assert.equal(moved, true);
  const matching = knowledge.listIndexedKnowledgeDocuments().filter((document) => document.sha256 === "ramayana-hash");
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.path, "/new/vault/ramayana.pdf");
});

test("detects page-marker-only indexes instead of treating scanned PDFs as knowledge", () => {
  knowledge.saveKnowledgeDocument({
    id: randomUUID(), path: "/private/local/scanned.pdf", title: "Scanned textbook", format: "pdf", sizeBytes: 500, sha256: "scanned-hash",
    chunks: [{ id: randomUUID(), ordinal: 1, content: "[Page 1] [Page 2] [Page 3]" }],
  });
  assert.equal(knowledge.indexedDocumentUsefulCharacters("/private/local/scanned.pdf"), 0);
  assert.equal(knowledge.removeKnowledgeDocumentByPath("/private/local/scanned.pdf"), true);
  assert.equal(knowledge.listIndexedKnowledgeDocuments().some((document) => document.sha256 === "scanned-hash"), false);
});

test("recognizes broad teaching-capability questions instead of retrieving a random passage", () => {
  assert.equal(knowledge.isKnowledgeCatalogQuestion("What all can you teach?"), true);
  assert.equal(knowledge.isKnowledgeCatalogQuestion("Which topics can I learn here?"), true);
  assert.equal(knowledge.isKnowledgeCatalogQuestion("Explain Python exceptions"), false);
});

test("recognizes subject news questions without confusing teaching questions", () => {
  assert.equal(knowledge.isKnowledgeNewsQuestion("What's new in data science this week?"), true);
  assert.equal(knowledge.isKnowledgeNewsQuestion("Tell me the latest AI model developments"), true);
  assert.equal(knowledge.isKnowledgeNewsQuestion("Explain the pandas string dtype"), false);
  assert.match(knowledge.buildKnowledgeNewsAnswer("What's new this week?"), /Data science intelligence brief/);
});

test("auto-searches the vault for informational Smart-mode questions", () => {
  assert.equal(knowledge.shouldAutoSearchKnowledge("How do Python modules work?"), true);
  assert.equal(knowledge.shouldAutoSearchKnowledge("Compare NumPy arrays and Python lists"), true);
  assert.equal(knowledge.shouldAutoSearchKnowledge("Tell me about Egyptian mythology"), true);
  assert.equal(knowledge.shouldAutoSearchKnowledge("Hey!"), false);
  assert.equal(knowledge.shouldAutoSearchKnowledge("Thanks"), false);
});
