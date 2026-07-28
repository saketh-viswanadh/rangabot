import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleStoryCollectionDraft, buildFallbackWordDraft, buildStoryPartPrompt, buildWordConversationPrompt, buildWordDraftPrompt, createWordArtifact, parseStoryDraftPart, parseWordBriefFromPlan, parseWordDocumentPlan, parseWordDraft, resetArtifactsRootForTests, resolveArtifactFile, setArtifactsRootForTests, shouldPlanWordDocument, validateWordBrief, validateWordDraftForBrief } from "../lib/word-documents.ts";
import { buildRamayanaStoryCollection } from "../lib/story-packs/ramayana.ts";

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
  assert.match(buildWordDraftPrompt(brief), /do not fabricate citations, quotations, dates, or disputed details/i);
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
  assert.match(buildWordConversationPrompt([{ role: "user", content: "Write interesting Ramayana stories for kids." }]), /story-collection/i);
});

test("requires finished stories and never substitutes planning scaffolding", () => {
  const storyBrief = {
    title: "Adventures from the Ramayana",
    documentType: "story-collection" as const,
    audience: "Children aged 10-12",
    purpose: "Share engaging Ramayana stories about loyalty",
    tone: "warm" as const,
    sourceNotes: "Ramayana stories for children; simplify the language.",
  };
  assert.match(buildWordDraftPrompt(storyBrief), /actual story collection, not a report/i);
  assert.throws(() => buildFallbackWordDraft(storyBrief), /will not replace missing stories/i);
  assert.throws(() => validateWordDraftForBrief(storyBrief, {
    subtitle: "A report for children",
    executiveSummary: "This report describes stories.",
    sections: [
      { heading: "Purpose and audience", paragraphs: ["For children."], bullets: [] },
      { heading: "Source material", paragraphs: [], bullets: ["ramayana"] },
    ],
    assumptions: [],
  }), /planning scaffolding/i);
  const rawPlan = JSON.stringify({ action: "create", brief: { ...storyBrief, sourceNotes: "" }, draft: {} });
  assert.equal(parseWordBriefFromPlan(rawPlan, "Conversation stays private.")?.sourceNotes, "Conversation stays private.");
  assert.match(buildStoryPartPrompt(storyBrief, "Bharata guards Rama's throne", "Bharata placed Rama's sandals on the throne."), /Do not invent a character's death/i);
  const storyText = Array.from({ length: 130 }, (_, index) => `word${index}`).join(" ");
  const part = parseStoryDraftPart(JSON.stringify({ title: "The Sandals on the Throne", paragraphs: [storyText], reflection: "What makes a promise important?" }));
  const collection = assembleStoryCollectionDraft(storyBrief, [part, { ...part, title: "Two" }, { ...part, title: "Three" }, { ...part, title: "Four" }]);
  assert.equal(collection.sections.length, 4);
  assert.equal(collection.sections[0].bullets[0].startsWith("Think about it:"), true);
  const ramayana = buildRamayanaStoryCollection(storyBrief);
  const storyContent = JSON.stringify(ramayana);
  assert.match(storyContent, /Bharata.*sandals/i);
  assert.match(storyContent, /Jatayu.*wounded/i);
  assert.doesNotMatch(storyContent, /Jatayu.*rescued Sita/i);
  assert.doesNotMatch(storyContent, /Rama.*sacrificed himself/i);
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
