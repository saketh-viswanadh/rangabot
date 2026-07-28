import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWordDraftPrompt, createWordArtifact, parseWordDraft, resetArtifactsRootForTests, resolveArtifactFile, setArtifactsRootForTests, validateWordBrief } from "../lib/word-documents.ts";

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
