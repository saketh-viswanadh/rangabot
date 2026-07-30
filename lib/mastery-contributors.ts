import type { MasteryTree } from "./mastery-tree.ts";

export type ClaimEvidence = { kind: "pull_request" | "commit"; reference: string };
export type MasteryClaim = { nodeId: string; contribution: string; evidence: ClaimEvidence[] };
export type MasteryContributor = { name: string; github: string; avatar: string | null; role: string; achievement: string; claims: MasteryClaim[] };
export type MasteryContributorRegistry = { version: number; policy: string; contributors: MasteryContributor[] };

export function validateMasteryContributors(value: unknown, tree: MasteryTree): asserts value is MasteryContributorRegistry {
  if (!value || typeof value !== "object") throw new Error("Mastery contributor registry must be an object.");
  const registry = value as Partial<MasteryContributorRegistry>;
  if (registry.version !== 1 || !registry.policy?.includes("CODEOWNER")) throw new Error("Mastery contributor governance policy is missing.");
  if (!Array.isArray(registry.contributors)) throw new Error("Mastery contributors must be an array.");
  const nodeIds = new Set(tree.branches.flatMap((branch) => branch.nodes.map((node) => node.id)));
  const handles = new Set<string>();
  for (const contributor of registry.contributors) {
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(contributor.github) || handles.has(contributor.github.toLowerCase())) throw new Error(`Invalid or duplicate GitHub handle: ${contributor.github}`);
    handles.add(contributor.github.toLowerCase());
    if (!contributor.name.trim() || !contributor.role.trim() || !contributor.achievement.trim()) throw new Error(`Contributor ${contributor.github} is missing public attribution.`);
    if (contributor.avatar !== null && !contributor.avatar.startsWith("/mastery/contributors/")) throw new Error(`Contributor ${contributor.github} avatar must be local.`);
    if (!Array.isArray(contributor.claims) || !contributor.claims.length) throw new Error(`Contributor ${contributor.github} needs at least one evidence-backed claim.`);
    const claimed = new Set<string>();
    for (const claim of contributor.claims) {
      if (!nodeIds.has(claim.nodeId) || claimed.has(claim.nodeId)) throw new Error(`Invalid or duplicate node claim: ${claim.nodeId}`);
      claimed.add(claim.nodeId);
      if (claim.contribution.trim().length < 20) throw new Error(`Claim ${claim.nodeId} needs a concrete contribution summary.`);
      if (!Array.isArray(claim.evidence) || !claim.evidence.length) throw new Error(`Claim ${claim.nodeId} needs merged evidence.`);
      for (const evidence of claim.evidence) {
        const valid = evidence.kind === "pull_request" ? /^#[1-9]\d*$/.test(evidence.reference) : /^[a-f\d]{7,40}$/i.test(evidence.reference);
        if (!valid) throw new Error(`Claim ${claim.nodeId} has invalid ${evidence.kind} evidence.`);
      }
    }
  }
}
