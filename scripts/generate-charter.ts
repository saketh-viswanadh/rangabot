import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeLineEndings } from "../lib/text-normalization.ts";

type Charter = {
  version: number;
  updatedAt: string;
  vision: string[];
  mission: string[];
  tagline: string;
  promise: string;
  decisionTest: string;
  principles: Array<{ id: string; title: string; summary: string }>;
  identity: Array<{ id: string; title: string; description: string }>;
};

const charter = JSON.parse(readFileSync(resolve("content/rangabot-charter.json"), "utf8")) as Charter;
if (charter.version !== 1 || charter.vision.length !== 2 || charter.mission.length !== 2 || charter.principles.length !== 12 || charter.identity.length !== 10) throw new Error("Rangabot charter structure is incomplete.");
const ids = [...charter.principles, ...charter.identity].map((item) => item.id);
if (new Set(ids).size !== ids.length) throw new Error("Rangabot charter identifiers must be unique.");

const principles = charter.principles.map((principle, index) => `### ${index + 1}. ${principle.title}\n\n${principle.summary}`).join("\n\n");
const identity = charter.identity.map((item) => `- **${item.title}:** ${item.description}`).join("\n");
const markdown = `# Rangabot charter\n\n> Version ${charter.version} · adopted ${charter.updatedAt} · canonical source: [content/rangabot-charter.json](../content/rangabot-charter.json)\n\n## Vision\n\n${charter.vision.join("\n\n")}\n\n## Mission\n\n${charter.mission.join("\n\n")}\n\n## Public tagline\n\n> **${charter.tagline}**\n\n## Personal promise\n\n> **${charter.promise}**\n\n## North-star principles\n\n${principles}\n\n## Rangabot's intended identity\n\n${identity}\n\n## Governing decision test\n\n> ${charter.decisionTest}\n\nThe charter governs product priorities, architecture, evaluation, public claims, and Path to Mastery acceptance criteria. A proposal that cannot explain how it advances this charter should not displace higher-value work.\n`;
const outputPath = resolve("docs/RANGABOT_CHARTER.md");
if (process.argv.includes("--check")) {
  if (normalizeLineEndings(readFileSync(outputPath, "utf8")) !== normalizeLineEndings(markdown)) throw new Error("docs/RANGABOT_CHARTER.md is stale. Run npm run charter:generate.");
} else {
  writeFileSync(outputPath, markdown);
  console.log(`Generated ${outputPath}`);
}
