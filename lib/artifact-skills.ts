export type ArtifactSkillStatus = "foundation" | "next" | "backlog";

export type ArtifactSkill = {
  id: "word" | "pdf" | "email" | "writing" | "technical-docs" | "slides" | "spreadsheet";
  name: string;
  outcome: string;
  status: ArtifactSkillStatus;
  dependsOn: ArtifactSkill["id"][];
};

export const artifactQualityGates = [
  "structured-brief",
  "content-completeness",
  "deterministic-render",
  "format-validation",
  "visual-review",
  "user-preview",
] as const;

export const artifactSkills: ArtifactSkill[] = [
  { id: "word", name: "Professional Word documents", outcome: "Create and edit polished DOCX files", status: "next", dependsOn: [] },
  { id: "pdf", name: "PDF reports", outcome: "Create validated printable reports and summaries", status: "backlog", dependsOn: ["word"] },
  { id: "email", name: "Email drafting", outcome: "Draft clear local emails without sending them", status: "backlog", dependsOn: [] },
  { id: "writing", name: "Writing studio", outcome: "Plan, draft, revise and critique long-form writing", status: "backlog", dependsOn: [] },
  { id: "technical-docs", name: "Technical documentation", outcome: "Create repository-grounded documentation and diagrams", status: "backlog", dependsOn: ["word", "pdf"] },
  { id: "slides", name: "Presentation decks", outcome: "Create story-led PPTX decks with visual QA", status: "backlog", dependsOn: ["pdf"] },
  { id: "spreadsheet", name: "Spreadsheets", outcome: "Create validated XLSX files with formulas and charts", status: "backlog", dependsOn: [] },
];

export function nextArtifactSkill() {
  return artifactSkills.find((skill) => skill.status === "next") ?? null;
}
