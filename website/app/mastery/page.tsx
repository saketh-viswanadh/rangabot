import type { Metadata } from "next";
import Link from "next/link";
import { masteryPaths, repositoryUrl } from "../../lib/site-content";
import { PageHero } from "../../components/PageHero";

export const metadata: Metadata = { title: "Path to Mastery", description: "Rangabot's evidence-backed public capability roadmap." };

export default function MasteryPage() {
  return (
    <>
      <PageHero eyebrow="Public capability roadmap" title="Progress that can be challenged." description="Every node is a real program capability. It unlocks only when every acceptance criterion has merged evidence—and a failed regression can lock it again." compact />
      <section className="mastery-overview section-shell">
        <div className="mastery-summary-grid">
          <div className="readiness-disc"><div><strong>18%</strong><span>Capability readiness<br />8 of 45 fully unlocked</span></div></div>
          <div className="mastery-path-list">
            {masteryPaths.map((path) => <article className="mastery-path" key={path.name}><div><h3>{path.name}</h3><p>{path.detail}</p></div><strong>{path.progress}%</strong><div className="progress-track"><i style={{ width: `${path.progress}%` }} /></div></article>)}
          </div>
        </div>
        <div className="callout"><strong>46% development progress is not 46% product readiness.</strong><p>Partial criteria receive half-credit in the secondary development metric. The primary readiness figure counts only capabilities whose complete gate is verified. Evidence was last reconciled on 2 August 2026.</p></div>
      </section>
      <section className="mastery-principles">
        <div className="section-shell"><div className="section-heading"><div><span className="eyebrow">The scoring covenant</span><h2>No victory by declaration.</h2></div><p>Private answers remain private. Public evidence points to reproducible suites, merged implementation and clear limitations.</p></div><div className="feature-list"><article><span>01</span><h3>Criteria, not code</h3><p>A merged feature proves delivery, not mastery. Every listed behavior must pass.</p></article><article><span>02</span><h3>Regressions count</h3><p>A formerly dependable capability can return to training when a gate fails.</p></article><article><span>03</span><h3>Credit stays</h3><p>Contributor achievements remain attached to the people and evidence that earned them.</p></article></div></div>
      </section>
      <section className="community-call section-shell" style={{ marginTop: 110 }}><div><span className="eyebrow">Complete audit</span><h2>Inspect every node and checklist.</h2><p>The repository contains the generated criterion-level Path to Mastery, evidence registry and contributor governance.</p></div><div className="community-actions"><Link className="button button-gold" href={`${repositoryUrl}/blob/main/docs/PATH_TO_MASTERY.md`}>Open the full audit <span>↗</span></Link></div></section>
    </>
  );
}
