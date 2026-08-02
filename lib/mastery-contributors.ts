import type { MasteryEvidenceRegistry, MasteryTree } from "./mastery-tree.ts";

export type MasteryClaim = { nodeId: string; contribution: string; evidence: string[] };
export type MasteryContributor = { name: string; github: string; avatar: string | null; role: string; achievement: string; claims: MasteryClaim[] };
export type MasteryContributorRegistry = { version: 2; policy: string; contributors: MasteryContributor[] };

export function validateMasteryContributors(value: unknown, tree: MasteryTree, evidence: MasteryEvidenceRegistry): asserts value is MasteryContributorRegistry {
  if (!value || typeof value !== "object") throw new Error("Mastery contributor registry must be an object.");
  const registry = value as Partial<MasteryContributorRegistry>;
  if (registry.version !== 2 || !registry.policy?.includes("CODEOWNER")) throw new Error("Mastery contributor governance policy is missing.");
  if (!Array.isArray(registry.contributors)) throw new Error("Mastery contributors must be an array.");
  const nodes = new Map(tree.epics.flatMap((epic) => epic.nodes.map((node) => [node.id, node])));
  const evidenceById = new Map(evidence.entries.map((entry) => [entry.id, entry]));
  const handles = new Set<string>();
  for (const contributor of registry.contributors) {
    const handle = contributor.github.toLowerCase();
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(contributor.github) || handles.has(handle)) throw new Error(`Invalid or duplicate GitHub handle: ${contributor.github}`);
    handles.add(handle);
    if (!contributor.name.trim() || !contributor.role.trim() || !contributor.achievement.trim()) throw new Error(`Contributor ${contributor.github} is missing public attribution.`);
    if (contributor.avatar !== null && !contributor.avatar.startsWith("/mastery/contributors/")) throw new Error(`Contributor ${contributor.github} avatar must be local.`);
    if (!Array.isArray(contributor.claims) || !contributor.claims.length) throw new Error(`Contributor ${contributor.github} needs at least one evidence-backed claim.`);
    const claimed = new Set<string>();
    for (const claim of contributor.claims) {
      const node = nodes.get(claim.nodeId);
      if (!node || claimed.has(claim.nodeId)) throw new Error(`Invalid or duplicate node claim: ${claim.nodeId}`);
      claimed.add(claim.nodeId);
      if (node.criteria.every((criterion) => criterion.state === "planned")) throw new Error(`Claim ${claim.nodeId} cannot credit an entirely planned capability.`);
      if (claim.contribution.trim().length < 20) throw new Error(`Claim ${claim.nodeId} needs a concrete contribution summary.`);
      if (!Array.isArray(claim.evidence) || !claim.evidence.length) throw new Error(`Claim ${claim.nodeId} needs merged evidence.`);
      for (const evidenceId of claim.evidence) {
        const entry = evidenceById.get(evidenceId);
        if (!entry) throw new Error(`Claim ${claim.nodeId} has unknown evidence ${evidenceId}.`);
        if (!entry.contributors.map((name) => name.toLowerCase()).includes(handle)) throw new Error(`${evidenceId} does not attribute ${contributor.github}.`);
      }
    }
  }
}
