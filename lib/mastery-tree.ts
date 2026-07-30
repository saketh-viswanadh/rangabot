export const masteryStatuses = ["vision", "locked", "ready", "in-progress", "training", "unlocked", "mastered", "regressed"] as const;
export type MasteryStatus = typeof masteryStatuses[number];

export type MasteryNode = {
  id: string;
  name: string;
  status: MasteryStatus;
  score: number;
  description: string;
  dependencies: string[];
  acceptance: string[];
  evidence: string[];
  backlog: string;
};

export type MasteryTree = {
  version: number;
  title: string;
  updatedAt: string;
  vision: string;
  core: Omit<MasteryNode, "dependencies" | "acceptance" | "evidence" | "backlog"> & { subtitle: string; unlockCriteria: string[] };
  branches: Array<{ id: string; name: string; glyph: string; summary: string; score: number; nodes: MasteryNode[] }>;
};

export function validateMasteryTree(value: unknown): asserts value is MasteryTree {
  if (!value || typeof value !== "object") throw new Error("Mastery tree must be an object.");
  const tree = value as Partial<MasteryTree>;
  if (tree.version !== 1 || !tree.title || !tree.updatedAt || !tree.vision || !tree.core || !Array.isArray(tree.branches) || tree.branches.length < 4) throw new Error("Mastery tree metadata is incomplete.");
  const ids = new Set<string>([tree.core.id]);
  const nodes: MasteryNode[] = [];
  for (const branch of tree.branches) {
    if (!branch.id || !branch.name || !branch.glyph || !branch.summary || !Number.isFinite(branch.score) || branch.score < 0 || branch.score > 5 || !Array.isArray(branch.nodes) || !branch.nodes.length) throw new Error(`Invalid mastery branch: ${branch.id ?? "unknown"}`);
    if (ids.has(branch.id)) throw new Error(`Duplicate mastery id: ${branch.id}`);
    ids.add(branch.id);
    for (const node of branch.nodes) {
      if (!node.id || !node.name || !masteryStatuses.includes(node.status) || !Number.isFinite(node.score) || node.score < 0 || node.score > 5 || !node.description || !node.backlog || !Array.isArray(node.dependencies) || !Array.isArray(node.acceptance) || node.acceptance.length < 2 || !Array.isArray(node.evidence)) throw new Error(`Invalid mastery node: ${node.id ?? "unknown"}`);
      if (ids.has(node.id)) throw new Error(`Duplicate mastery id: ${node.id}`);
      ids.add(node.id);
      nodes.push(node);
    }
  }
  for (const node of nodes) for (const dependency of node.dependencies) if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} on ${node.id}`);
}

export function masteryProgress(tree: MasteryTree) {
  const nodes = tree.branches.flatMap((branch) => branch.nodes);
  const unlocked = nodes.filter((node) => node.status === "unlocked" || node.status === "mastered").length;
  const active = nodes.filter((node) => node.status === "training" || node.status === "in-progress").length;
  return { total: nodes.length, unlocked, active, percent: Math.round(nodes.reduce((sum, node) => sum + node.score, 0) / (nodes.length * 5) * 100) };
}
