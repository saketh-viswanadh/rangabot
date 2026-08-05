export const repositoryUrl = "https://github.com/saketh-viswanadh/rangabot";

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
    value: "10/12",
    label: "Analytical transfer",
    note: "Frozen astronomy holdout. Useful progress, still below the 90% release target.",
  },
] as const;

export const masteryPaths = [
  { name: "Mind & Memory", progress: 59, detail: "Conversation, intent, memory, learning and self-review", tone: "gold" },
  { name: "Scholar", progress: 69, detail: "Vault ingestion, retrieval, teaching and synthesis", tone: "sage" },
  { name: "Analyst", progress: 36, detail: "Local execution, evidence and analytical reporting", tone: "plum" },
  { name: "Builder", progress: 34, detail: "Repository context, code understanding and delivery", tone: "blue" },
  { name: "Creator", progress: 21, detail: "Documents, writing, presentation and structured artifacts", tone: "clay" },
  { name: "Companion", progress: 17, detail: "Daily assistance, communications and approved services", tone: "moss" },
] as const;

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
  { title: "Explore", links: [["Product", "/product"], ["Showcase", "/showcase"], ["Path to Mastery", "/mastery"], ["Evidence", "/evidence"]] },
  { title: "Trust", links: [["Privacy", "/privacy"], ["Documentation", "/docs"], ["Download", "/download"]] },
  { title: "Open source", links: [["Community", "/community"], ["GitHub", repositoryUrl], ["Contributing", `${repositoryUrl}/blob/main/CONTRIBUTING.md`]] },
] as const;
