"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo, useState, type CSSProperties } from "react";
import treeData from "@/content/path-to-mastery.json";
import contributorsData from "@/content/mastery-contributors.json";
import masteryBanner from "@/docs/media/rangabot-social-preview.png";
import { CraftIcon, type CraftIconName } from "@/app/components/craft-icon";
import { masteryProgress, type MasteryNode, type MasteryStatus, type MasteryTree } from "@/lib/mastery-tree";
import { productConfig } from "@/lib/product-config";
import "./mastery.css";

const tree = treeData as MasteryTree;
const repositoryUrl = productConfig.repositoryUrl;
const statusLabels: Record<MasteryStatus, string> = { vision: "Vision", locked: "Locked", ready: "Ready", "in-progress": "In progress", training: "Training", unlocked: "Unlocked", mastered: "Mastered", regressed: "Regressed" };
type SelectedNode = MasteryNode & { branchName: string };
const branchIcons: CraftIconName[] = ["spark", "knowledge", "search", "code", "document", "chat", "shield", "mastery"];

export default function MasteryPage() {
  const progress = useMemo(() => masteryProgress(tree), []);
  const nodeNames = useMemo(() => new Map(tree.branches.flatMap((branch) => branch.nodes.map((node) => [node.id, node.name]))), []);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const selectedContributors = selected ? contributorsData.contributors.filter((contributor) => contributor.claims.some((claim) => claim.nodeId === selected.id)) : [];
  return (
    <main className="mastery-shell">
      <header className="mastery-header">
        <Link href="/" className="mastery-back"><CraftIcon name="chevron" size={15} /> Rangabot</Link>
        <div className="mastery-title"><span className="mastery-kicker">Public capability roadmap</span><h1>{tree.title}</h1><p>{tree.vision}</p></div>
        <div className="mastery-summary" aria-label="Mastery summary"><strong>{progress.percent}%</strong><span>{progress.unlocked} unlocked · {progress.active} training · {progress.total} total</span><small>Verified {tree.updatedAt}</small></div>
      </header>
      <section className="mastery-banner" aria-label="Rangabot local AI"><Image src={masteryBanner} alt="Rangabot, private local AI that learns from your documents" priority /></section>
      <section className="mastery-legend" aria-label="Skill status legend">
        {(Object.keys(statusLabels) as MasteryStatus[]).map((status) => <span key={status} data-status={status}><i />{statusLabels[status]}</span>)}
      </section>
      <section className="mastery-core" aria-labelledby="mastery-core-title">
        <div className="core-rings" aria-hidden="true"><i /><i /><i /></div><span className="core-mark" aria-hidden="true" />
        <div><small>Main mastery</small><h2 id="mastery-core-title">{tree.core.name}</h2><p>{tree.core.subtitle}</p></div>
        <strong>{tree.core.score.toFixed(1)}<small>/5</small></strong>
      </section>
      <section className="mastery-paths" aria-label="Rangabot mastery paths">
        {tree.branches.map((branch, branchIndex) => (
          <article className="mastery-branch" key={branch.id} style={{ "--branch-index": branchIndex } as CSSProperties}>
            <header><span className="branch-glyph"><CraftIcon name={branchIcons[branchIndex]} /></span><div><small>Mastery path</small><h2>{branch.name}</h2></div><strong>{branch.score.toFixed(1)}<small>/5</small></strong></header>
            <p>{branch.summary}</p>
            <ol>{branch.nodes.map((node, nodeIndex) => <li key={node.id} data-status={node.status} style={{ "--node-index": nodeIndex } as CSSProperties}>
              <button type="button" onClick={() => setSelected({ ...node, branchName: branch.name })} aria-label={`${node.name}, ${statusLabels[node.status]}, score ${node.score} out of 5`}>
                <span className="node-emblem"><i /></span>
                <span className="node-copy"><strong>{node.name}</strong><small>{statusLabels[node.status]} · {node.score.toFixed(1)}/5</small></span>
              </button>
              <aside className="node-unlock"><small>How to unlock</small><strong>{node.acceptance[0]}</strong>{node.acceptance[1] && <span>{node.acceptance[1]}</span>}<a href={`${repositoryUrl}/blob/main/docs/PATH_TO_MASTERY.md#${node.id}`} target="_blank" rel="noreferrer">Complete checklist <CraftIcon name="external" size={12} /></a></aside>
            </li>)}</ol>
          </article>
        ))}
      </section>
      <section className="mastery-achievements" aria-labelledby="achievement-title"><div><span className="mastery-kicker">Built by the pack</span><h2 id="achievement-title">Achievements remembered</h2><p>Every credited milestone stays attached to the people who helped unlock it. Claims require merged evidence and official CODEOWNER approval.</p></div><ul>{contributorsData.contributors.map((contributor) => <li key={contributor.github}><a href={`https://github.com/${contributor.github}`} target="_blank" rel="noreferrer"><span className="contributor-avatar" aria-hidden="true">{contributor.avatar ? <Image src={contributor.avatar} alt="" width={48} height={48} /> : contributor.name.slice(0, 1)}</span><span><strong>{contributor.name}</strong><small>@{contributor.github} · {contributor.role}</small><em>{contributor.achievement}</em><b>{contributor.claims.length} verified contributions</b><span className="contributor-claims">{contributor.claims.map((claim) => <i key={claim.nodeId}>{nodeNames.get(claim.nodeId)}</i>)}</span></span></a></li>)}</ul><a className="claim-skill" href={`${repositoryUrl}/issues/new?template=mastery-claim.yml`} target="_blank" rel="noreferrer">Request an official contribution claim <CraftIcon name="external" size={12} /></a></section>
      <footer className="mastery-footer"><p><strong>This tree is also the backlog.</strong> Nodes unlock only after their code is merged and every listed acceptance criterion passes. A failed regression can relock a skill.</p><a href={repositoryUrl} target="_blank" rel="noreferrer">View Rangabot on GitHub <CraftIcon name="external" size={12} /></a></footer>
      {selected && <div className="mastery-modal" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelected(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="selected-mastery-title" data-status={selected.status}>
          <button className="mastery-close" type="button" onClick={() => setSelected(null)} aria-label="Close mastery details"><CraftIcon name="close" /></button>
          <span className="detail-path">{selected.branchName} · {statusLabels[selected.status]}</span><h2 id="selected-mastery-title">{selected.name}</h2>
          <div className="detail-score"><strong>{selected.score.toFixed(1)}</strong><span>/ 5 maturity</span></div><p>{selected.description}</p>
          <h3>Unlock requirements</h3><ul>{selected.acceptance.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
          <a className="detail-checklist" href={`${repositoryUrl}/blob/main/docs/PATH_TO_MASTERY.md#${selected.id}`} target="_blank" rel="noreferrer">Open the complete public checklist <CraftIcon name="external" size={12} /></a>
          <h3>Dependencies</h3><p className="detail-tags">{selected.dependencies.length ? selected.dependencies.map((dependency) => <span key={dependency}>{dependency.replaceAll("-", " ")}</span>) : <span>Foundation node</span>}</p>
          <h3>Evidence</h3><p className="detail-tags">{selected.evidence.length ? selected.evidence.map((evidence) => <span key={evidence}>{evidence}</span>) : <span>No verified evidence yet</span>}</p>
          <h3>Contributors</h3>{selectedContributors.length ? <ul className="detail-contributors">{selectedContributors.map((contributor) => { const claim = contributor.claims.find((item) => item.nodeId === selected.id); return <li key={contributor.github}><strong>{contributor.name}</strong><span>{claim?.contribution}</span><small>{claim?.evidence.map((item) => item.reference).join(" · ")}</small></li>; })}</ul> : <p>No official contribution claim recorded yet.</p>}
          <div className="detail-next"><small>Next backlog item</small><strong>{selected.backlog}</strong></div>
        </section>
      </div>}
    </main>
  );
}
