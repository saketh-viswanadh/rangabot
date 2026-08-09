import type { Metadata } from "next";
import { PageHero } from "../../components/PageHero";
import { charter } from "../../lib/site-content";

export const metadata: Metadata = {
  title: "Charter",
  description: "Rangabot's vision, mission, promise, and governing north-star principles.",
};

export default function CharterPage() {
  return (
    <>
      <PageHero eyebrow="The Rangabot charter" title="Extraordinary capability from ordinary machines." description={charter.tagline} compact />
      <section className="charter-statements section-shell">
        <article><span className="eyebrow">Vision</span>{charter.vision.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</article>
        <article><span className="eyebrow">Mission</span>{charter.mission.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</article>
      </section>
      <section className="promise-band"><div className="section-shell"><span className="eyebrow">Personal promise</span><blockquote>{charter.promise}</blockquote></div></section>
      <section className="content-section section-shell">
        <div className="section-heading"><div><span className="eyebrow">North-star principles</span><h2>The rules above every feature.</h2></div><p>These principles govern architecture, model choice, evaluation, public claims, and the Path to Mastery. They apply equally to a quiet conversation and a specialist capability pack.</p></div>
        <div className="principle-grid">{charter.principles.map((principle, index) => <article key={principle.id}><span>{String(index + 1).padStart(2, "0")}</span><h3>{principle.title}</h3><p>{principle.summary}</p></article>)}</div>
      </section>
      <section className="identity-section"><div className="section-shell"><div className="section-heading"><div><span className="eyebrow">One coherent intelligence</span><h2>Ten roles. One Rangabot.</h2></div><p>These identities become the capability paths. They are not separate personalities or hidden agents; Mind & Memory remains the control plane.</p></div><div className="identity-grid">{charter.identity.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.description}</p></article>)}</div></div></section>
      <section className="north-star-test section-shell"><span className="eyebrow">Governing decision test</span><blockquote>{charter.decisionTest}</blockquote><a className="button button-ink" href="/mastery">See the charter translated into mastery <span>→</span></a></section>
    </>
  );
}
