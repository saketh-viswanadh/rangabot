export const masteryStatuses = ["vision", "locked", "ready", "in-progress", "training", "unlocked", "mastered", "regressed"] as const;
export type MasteryStatus = typeof masteryStatuses[number];
export const criterionStates = ["verified", "partial", "planned", "failed"] as const;
export type CriterionState = typeof criterionStates[number];

export type MasteryCriterion = {
  id: string;
  text: string;
  state: CriterionState;
  evidence: string[];
  note?: string;
};

export type MasteryNodeSource = {
  id: string;
  name: string;
  description: string;
  dependencies: string[];
  criteria: MasteryCriterion[];
  backlog: string;
  vision?: boolean;
  previouslyUnlocked?: boolean;
};

export type MasteryEpicSource = {
  id: string;
  name: string;
  glyph: string;
  summary: string;
  nodes: MasteryNodeSource[];
};

export type MasteryTreeSource = {
  version: 2;
  title: string;
  updatedAt: string;
  evidenceVerifiedAt: string;
  vision: string;
  core: { id: string; name: string; subtitle: string; description: string; unlockCriteria: string[] };
  epics: MasteryEpicSource[];
};

export type MasteryNode = MasteryNodeSource & {
  status: MasteryStatus;
  score: number;
  verifiedCriteria: number;
  totalCriteria: number;
};

export type MasteryEpic = Omit<MasteryEpicSource, "nodes"> & {
  score: number;
  progressPercent: number;
  nodes: MasteryNode[];
};

export type MasteryTree = Omit<MasteryTreeSource, "epics" | "core"> & {
  core: MasteryTreeSource["core"] & { status: MasteryStatus; score: number };
  epics: MasteryEpic[];
  branches: MasteryEpic[];
};

export type MasteryEvidenceEntry = {
  id: string;
  kind: "pull_request";
  reference: string;
  title: string;
  url: string;
  mergeCommit: string;
  mergedAt: string;
  contributors: string[];
};

export type MasteryEvidenceRegistry = {
  version: 1;
  repository: string;
  verifiedAt: string;
  entries: MasteryEvidenceEntry[];
};

const criterionWeight: Record<CriterionState, number> = { verified: 1, partial: 0.5, planned: 0, failed: 0 };

function nodeScore(node: MasteryNodeSource) {
  return node.criteria.reduce((sum, criterion) => sum + criterionWeight[criterion.state], 0) / node.criteria.length * 5;
}

function nodeStatus(node: MasteryNodeSource): MasteryStatus {
  if (node.vision) return "vision";
  const hasFailed = node.criteria.some((criterion) => criterion.state === "failed");
  const hasProgress = node.criteria.some((criterion) => criterion.state === "verified" || criterion.state === "partial");
  if (hasFailed && node.previouslyUnlocked) return "regressed";
  if (hasFailed || hasProgress && !node.criteria.every((criterion) => criterion.state === "verified")) return "training";
  if (node.criteria.every((criterion) => criterion.state === "verified")) return "unlocked";
  return node.dependencies.length ? "locked" : "ready";
}

export function materializeMasteryTree(source: MasteryTreeSource): MasteryTree {
  const epics = source.epics.map((epic) => {
    const nodes = epic.nodes.map((node) => ({
      ...node,
      status: nodeStatus(node),
      score: nodeScore(node),
      verifiedCriteria: node.criteria.filter((criterion) => criterion.state === "verified").length,
      totalCriteria: node.criteria.length,
    }));
    const criteria = epic.nodes.flatMap((node) => node.criteria);
    const progressPercent = Math.round(criteria.reduce((sum, criterion) => sum + criterionWeight[criterion.state], 0) / criteria.length * 100);
    return { ...epic, nodes, progressPercent, score: progressPercent / 20 };
  });
  const criteria = source.epics.flatMap((epic) => epic.nodes.flatMap((node) => node.criteria));
  const score = criteria.reduce((sum, criterion) => sum + criterionWeight[criterion.state], 0) / criteria.length * 5;
  return { ...source, epics, branches: epics, core: { ...source.core, score, status: "training" } };
}

export function validateMasteryTree(value: unknown, evidenceValue?: unknown): asserts value is MasteryTreeSource {
  if (!value || typeof value !== "object") throw new Error("Mastery tree must be an object.");
  const tree = value as Partial<MasteryTreeSource>;
  if (tree.version !== 2 || !tree.title || !tree.updatedAt || !tree.evidenceVerifiedAt || !tree.vision || !tree.core || !Array.isArray(tree.epics) || tree.epics.length < 9) throw new Error("Mastery program metadata is incomplete.");
  const evidence = evidenceValue as Partial<MasteryEvidenceRegistry> | undefined;
  if (!evidence || evidence.version !== 1 || !Array.isArray(evidence.entries)) throw new Error("Mastery evidence registry is missing.");
  const evidenceIds = new Set<string>();
  for (const entry of evidence.entries) {
    if (!/^pr-[1-9]\d*$/.test(entry.id) || evidenceIds.has(entry.id) || !/^#[1-9]\d*$/.test(entry.reference) || !/^https:\/\/github\.com\//.test(entry.url) || !/^[a-f\d]{40}$/.test(entry.mergeCommit) || !entry.title || !entry.mergedAt || !entry.contributors.length) throw new Error(`Invalid mastery evidence: ${entry.id ?? "unknown"}`);
    evidenceIds.add(entry.id);
  }
  const ids = new Set<string>([tree.core.id]);
  const nodes: MasteryNodeSource[] = [];
  for (const epic of tree.epics) {
    if (!epic.id || !epic.name || !epic.glyph || !epic.summary || !Array.isArray(epic.nodes) || !epic.nodes.length || ids.has(epic.id)) throw new Error(`Invalid mastery epic: ${epic.id ?? "unknown"}`);
    ids.add(epic.id);
    for (const node of epic.nodes) {
      if (!node.id || !node.name || !node.description || !node.backlog || !Array.isArray(node.dependencies) || !Array.isArray(node.criteria) || node.criteria.length < 3 || ids.has(node.id)) throw new Error(`Invalid mastery node: ${node.id ?? "unknown"}`);
      ids.add(node.id);
      const criterionIds = new Set<string>();
      for (const criterion of node.criteria) {
        if (!criterion.id || criterionIds.has(criterion.id) || !criterion.text || !criterionStates.includes(criterion.state) || !Array.isArray(criterion.evidence)) throw new Error(`Invalid criterion on ${node.id}: ${criterion.id ?? "unknown"}`);
        criterionIds.add(criterion.id);
        if ((criterion.state === "verified" || criterion.state === "partial" || criterion.state === "failed") && !criterion.evidence.length) throw new Error(`${node.id}/${criterion.id} needs evidence for ${criterion.state}.`);
        if (criterion.state === "planned" && criterion.evidence.length) throw new Error(`${node.id}/${criterion.id} cannot cite evidence while planned.`);
        for (const evidenceId of criterion.evidence) if (!evidenceIds.has(evidenceId)) throw new Error(`Unknown evidence ${evidenceId} on ${node.id}/${criterion.id}`);
      }
      nodes.push(node);
    }
  }
  for (const node of nodes) for (const dependency of node.dependencies) if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} on ${node.id}`);
}

export function masteryProgress(tree: MasteryTree) {
  const nodes = tree.epics.flatMap((epic) => epic.nodes);
  const criteria = nodes.flatMap((node) => node.criteria);
  const unlocked = nodes.filter((node) => node.status === "unlocked" || node.status === "mastered").length;
  const active = nodes.filter((node) => node.status === "training" || node.status === "in-progress" || node.status === "regressed").length;
  const verified = criteria.filter((criterion) => criterion.state === "verified").length;
  return { total: nodes.length, unlocked, active, criteriaTotal: criteria.length, criteriaVerified: verified, percent: Math.round(criteria.reduce((sum, criterion) => sum + criterionWeight[criterion.state], 0) / criteria.length * 100) };
}
