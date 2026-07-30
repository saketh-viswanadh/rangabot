"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties } from "react";
import treeData from "@/content/path-to-mastery.json";
import { masteryProgress, type MasteryNode, type MasteryStatus, type MasteryTree } from "@/lib/mastery-tree";
import "./mastery.css";

const tree = treeData as MasteryTree;
const statusLabels: Record<MasteryStatus, string> = { vision: "Vision", locked: "Locked", ready: "Ready", "in-progress": "In progress", training: "Training", unlocked: "Unlocked", mastered: "Mastered", regressed: "Regressed" };
type SelectedNode = MasteryNode & { branchName: string };

export default function MasteryPage() {
  const progress = useMemo(() => masteryProgress(tree), []);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  return (
    <main className="mastery-shell">
      <header className="mastery-header">
        <Link href="/" className="mastery-back"><span aria-hidden="true">‹</span> Rangabot</Link>
        <div><span className="mastery-kicker">Public capability roadmap</span><h1>{tree.title}</h1><p>{tree.vision}</p></div>
        <div className="mastery-summary" aria-label="Mastery summary"><strong>{progress.percent}%</strong><span>{progress.unlocked} unlocked · {progress.active} training · {progress.total} total</span><small>Verified {tree.updatedAt}</small></div>
      </header>
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
            <header><span className="branch-glyph" aria-hidden="true"><i>{branch.glyph}</i></span><div><small>Mastery path</small><h2>{branch.name}</h2></div><strong>{branch.score.toFixed(1)}<small>/5</small></strong></header>
            <p>{branch.summary}</p>
            <ol>{branch.nodes.map((node, nodeIndex) => <li key={node.id} data-status={node.status} style={{ "--node-index": nodeIndex } as CSSProperties}>
              <button type="button" onClick={() => setSelected({ ...node, branchName: branch.name })} aria-label={`${node.name}, ${statusLabels[node.status]}, score ${node.score} out of 5`}>
                <span className="node-emblem"><i>{node.status === "locked" ? "◇" : node.status === "unlocked" ? "✦" : node.status === "mastered" ? "◆" : "·"}</i></span>
                <span className="node-copy"><strong>{node.name}</strong><small>{statusLabels[node.status]} · {node.score.toFixed(1)}/5</small></span>
              </button>
            </li>)}</ol>
          </article>
        ))}
      </section>
      <footer className="mastery-footer"><p><strong>This tree is also the backlog.</strong> Nodes unlock only after their code is merged and every listed acceptance criterion passes. A failed regression can relock a skill.</p><a href="https://github.com/saketh-viswanadh/rangabot" target="_blank" rel="noreferrer">View Rangabot on GitHub ↗</a></footer>
      {selected && <div className="mastery-modal" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelected(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="selected-mastery-title" data-status={selected.status}>
          <button className="mastery-close" type="button" onClick={() => setSelected(null)} aria-label="Close mastery details">×</button>
          <span className="detail-path">{selected.branchName} · {statusLabels[selected.status]}</span><h2 id="selected-mastery-title">{selected.name}</h2>
          <div className="detail-score"><strong>{selected.score.toFixed(1)}</strong><span>/ 5 maturity</span></div><p>{selected.description}</p>
          <h3>Unlock requirements</h3><ul>{selected.acceptance.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
          <h3>Dependencies</h3><p className="detail-tags">{selected.dependencies.length ? selected.dependencies.map((dependency) => <span key={dependency}>{dependency.replaceAll("-", " ")}</span>) : <span>Foundation node</span>}</p>
          <h3>Evidence</h3><p className="detail-tags">{selected.evidence.length ? selected.evidence.map((evidence) => <span key={evidence}>{evidence}</span>) : <span>No verified evidence yet</span>}</p>
          <div className="detail-next"><small>Next backlog item</small><strong>{selected.backlog}</strong></div>
        </section>
      </div>}
    </main>
  );
}
