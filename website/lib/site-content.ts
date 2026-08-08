import charterSource from "../../content/rangabot-charter.json";
import masterySource from "../../content/path-to-mastery.json";

export const repositoryUrl = "https://github.com/saketh-viswanadh/rangabot";

export const charter = charterSource;
const weights: Record<string, number> = { verified: 1, partial: 0.5, planned: 0, failed: 0 };
const masteryNodes = masterySource.epics.flatMap((path) => path.nodes);
const fullyUnlocked = masteryNodes.filter((item) => item.criteria.every((criterion) => criterion.state === "verified")).length;
const criteria = masteryNodes.flatMap((item) => item.criteria);
export const masterySummary = {
  total: masteryNodes.length,
  fullyUnlocked,
  readiness: Math.round(fullyUnlocked / masteryNodes.length * 100),
  verifiedCriteria: criteria.filter((criterion) => criterion.state === "verified").length,
  totalCriteria: criteria.length,
  development: Math.round(criteria.reduce((total, criterion) => total + weights[criterion.state], 0) / criteria.length * 100),
  verifiedAt: masterySource.evidenceVerifiedAt,
};

export const pillars = [
  {
    eyebrow: "Mind & Memory",
    title: "A mind that listens before it remembers.",
    text: "Rangabot follows the current request first, carries useful conversation context, and uses only relevant memories you have approved.",
    href: "/product#mind",
    status: "Training",
    mark: "01",
  },
  {
    eyebrow: "Scholar",
    title: "Your books become a private classroom.",
    text: "The Knowledge Vault retrieves from local documents, shows its evidence, and separates sourced claims from model background.",
    href: "/product#scholar",
    status: "Available",
    mark: "02",
  },
  {
    eyebrow: "Analyst",
    title: "Questions become verified calculations.",
    text: "With explicit access, Rangabot plans and runs bounded read-only analysis, then exposes the query behind its explanation.",
    href: "/product#analyst",
    status: "Experimental",
    mark: "03",
  },
  {
    eyebrow: "Builder",
    title: "Local context for useful creation.",
    text: "Approve a repository, attach scoped code, and turn the conversation into explanations, plans, or validated Word documents.",
    href: "/product#builder",
    status: "Training",
    mark: "04",
  },
] as const;

export const evidenceCards = [
  {
    value: "59/60",
    label: "Conversation candidate",
    note: "Latest complete v1.0.11 candidate; repeat and blind-review release gates remain open.",
  },
  {
    value: "22/22",
    label: "Critical trust cases",
    note: "One complete candidate run. Intermittent failures still count during repeated release review.",
  },
  {
    value: "15/15",
    label: "Memory precision & recall",
    note: "Synthetic memory-selection audit; no real conversations or saved memories were inspected.",
  },
  {
    value: "44/44",
    label: "Grounded analytical narration",
    note: "Canonical renderer cases; 222/222 adversarial or invalid mutations were also rejected.",
  },
] as const;

export const masteryPaths = masterySource.epics.map((path) => {
  const pathCriteria = path.nodes.flatMap((item) => item.criteria);
  return {
    name: path.name,
    progress: Math.round(pathCriteria.reduce((total, criterion) => total + weights[criterion.state], 0) / pathCriteria.length * 100),
    detail: path.summary,
  };
});

export const docsGroups = [
  {
    title: "Begin",
    links: ["Installation", "First conversation", "Choose a model", "Run Doctor", "Troubleshooting"],
  },
  {
    title: "Mind & Memory",
    links: ["Save a memory", "Inspect local memory", "Correct or delete", "Understand precedence"],
  },
  {
    title: "Knowledge Vault",
    links: ["Add documents", "Ingest and index", "Handle incompatible files", "Evaluate retrieval"],
  },
  {
    title: "Local tools",
    links: ["Approve a dataset", "Ask analytical questions", "Attach repository context", "Create a Word document"],
  },
] as const;

export const footerGroups = [
  { title: "Explore", links: [["Charter", "/charter"], ["Product", "/product"], ["Showcase", "/showcase"], ["Path to Mastery", "/mastery"], ["Evidence", "/evidence"]] },
  { title: "Trust", links: [["Privacy", "/privacy"], ["Documentation", "/docs"], ["Download", "/download"]] },
  { title: "Open source", links: [["Community", "/community"], ["GitHub", repositoryUrl], ["Contributing", `${repositoryUrl}/blob/main/CONTRIBUTING.md`]] },
] as const;
