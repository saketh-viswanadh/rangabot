import assert from "node:assert/strict";
import test from "node:test";
import { parseKnowledgeBrief } from "../lib/knowledge-brief.ts";

test("turns structured weekly intelligence into readable cards", () => {
  const markdown = `### Data tools
#### DuckDB improves local analytics
- **Event date:** 2026-07-22
- **What changed:** Correctness fixes shipped.
- **Why it matters:** Local queries are safer.
- **Evidence:** Primary source — [Announcement](https://example.com/release)
- **Vault status:** Indexed locally.`;
  const [item] = parseKnowledgeBrief(markdown);
  assert.deepEqual(item, {
    category: "Data tools",
    title: "DuckDB improves local analytics",
    date: "2026-07-22",
    change: "Correctness fixes shipped.",
    why: "Local queries are safer.",
    evidenceLabel: "Primary source — Announcement",
    evidenceUrl: "https://example.com/release",
    vaultStatus: "Indexed locally.",
  });
});

test("ignores headings that are not structured update entries", () => {
  assert.deepEqual(parseKnowledgeBrief("# Brief\n\n### Watchlist\n\n- Nothing verified."), []);
});
