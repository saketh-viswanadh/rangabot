import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFallbackWordDraft, buildWordConversationPrompt, buildWordDraftPrompt, createWordArtifact, parseWordDocumentPlan, parseWordDraft, resetArtifactsRootForTests, resolveArtifactFile, setArtifactsRootForTests, shouldPlanWordDocument, validateWordBrief } from "../lib/word-documents.ts";

const brief = {
  title: "Analytics operating brief",
  documentType: "technical-brief" as const,
  audience: "Analytics engineers",
  purpose: "Explain the approved local workflow.",
  tone: "technical" as const,
  sourceNotes: "All processing stays on the local computer. Review generated output before use.",
};

test("validates a bounded structured Word brief", () => {
  assert.deepEqual(validateWordBrief(brief), brief);
  assert.throws(() => validateWordBrief({ ...brief, title: "" }), /Title is required/);
  assert.match(buildWordDraftPrompt(brief), /do not invent names, numbers, dates, sources, or project behavior/i);
});

test("rejects malformed model drafts and bounds valid content", () => {
  assert.throws(() => parseWordDraft('{"sections":[]}'), /invalid document structure/);
  const draft = parseWordDraft(JSON.stringify({
    subtitle: "Local-first workflow",
    executiveSummary: "This brief explains the local workflow.",
    sections: [
      { heading: "Context", paragraphs: ["The workflow is local."], bullets: [] },
      { heading: "Review", paragraphs: [], bullets: ["Review the output."] },
    ],
    assumptions: ["The configured local model is available."],
  }));
  assert.equal(draft.sections.length, 2);
  assert.equal(draft.assumptions.length, 1);
  const repaired = parseWordDraft(JSON.stringify({
    subtitle: "Local-first workflow",
    executiveSummary: "This brief explains the local workflow.",
    sections: [
      { heading: "Empty", paragraphs: [], bullets: [] },
      { heading: "Context", paragraphs: ["Local only."], bullets: [] },
      { heading: "Review", paragraphs: [], bullets: ["Review it."] },
    ],
    assumptions: [],
  }));
  assert.deepEqual(repaired.sections.map((section) => section.heading), ["Context", "Review"]);
});

test("starts and continues Word creation inside normal chat", () => {
  assert.equal(shouldPlanWordDocument([{ role: "user", content: "Create a Word document from our discussion." }]), true);
  assert.equal(shouldPlanWordDocument([
    { role: "user", content: "Create a Word document." },
    { role: "assistant", content: "Who is the audience?", artifactIntent: "word" },
    { role: "user", content: "The analytics leadership team." },
  ]), true);
  assert.equal(shouldPlanWordDocument([{ role: "user", content: "Explain Word embeddings." }]), false);
  assert.match(buildWordConversationPrompt([{ role: "user", content: "Use only these facts." }]), /exactly one concise natural follow-up question/i);
});

test("parses either a conversational follow-up or a complete document plan", () => {
  assert.deepEqual(parseWordDocumentPlan('{"action":"ask","question":"Who should read this document?"}'), { action: "ask", question: "Who should read this document?" });
  const plan = parseWordDocumentPlan(JSON.stringify({
    action: "create",
    brief,
    draft: {
      subtitle: "Local-first workflow",
      executiveSummary: "This brief explains the approved local workflow.",
      sections: [
        { heading: "Context", paragraphs: ["All processing stays local."], bullets: [] },
        { heading: "Review", paragraphs: ["Review every output."], bullets: [] },
      ],
      assumptions: [],
    },
  }));
  assert.equal(plan.action, "create");
  const missingNotesPlan = parseWordDocumentPlan(JSON.stringify({
    action: "create",
    brief: { ...brief, sourceNotes: undefined },
    draft: {
      subtitle: "Local-first workflow",
      executiveSummary: "This brief explains the approved local workflow.",
      sections: [{ heading: "Context", paragraphs: ["Local only."], bullets: [] }, { heading: "Review", paragraphs: ["Review it."], bullets: [] }],
      assumptions: [],
    },
  }), "Conversation facts stay local.");
  assert.equal(missingNotesPlan.action === "create" ? missingNotesPlan.brief.sourceNotes : "", "Conversation facts stay local.");
  const sparseModelPlan = parseWordDocumentPlan(JSON.stringify({
    action: "create",
    brief: { ...brief, sourceNotes: undefined },
    draft: { subtitle: "Sparse", executiveSummary: "", sections: [{ heading: "One", paragraphs: [], bullets: ["One fact"] }], assumptions: [] },
  }), brief.sourceNotes);
  assert.equal(sparseModelPlan.action === "create" ? sparseModelPlan.draft.sections.length : 0, 3);
  assert.equal(buildFallbackWordDraft(brief).sections[1].bullets.length, 2);
});

test("creates a real private DOCX with a quality report", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-word-"));
  setArtifactsRootForTests(root);
  try {
    const artifact = await createWordArtifact(brief, {
      subtitle: "Local-first workflow",
      executiveSummary: "This brief explains the approved local workflow.",
      sections: [
        { heading: "Context", paragraphs: ["All processing stays local."], bullets: [] },
        { heading: "Review process", paragraphs: ["Review all generated output."], bullets: ["Check facts", "Check layout"] },
        { heading: "Next steps", paragraphs: ["Use the validated document."], bullets: [] },
      ],
      assumptions: ["The reader has Microsoft Word or a compatible editor."],
    });
    const path = resolveArtifactFile(artifact.id, artifact.filename);
    assert.ok(path && existsSync(path));
    assert.ok(artifact.filename.endsWith(".docx"));
    assert.equal(artifact.checks.some((check) => check.id === "format-validation" && check.status === "passed"), true);
    assert.equal(artifact.checks.some((check) => check.id === "user-preview"), true);
  } finally {
    resetArtifactsRootForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
