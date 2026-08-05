import Link from "next/link";
import Image from "next/image";
import { evidenceCards, pillars, repositoryUrl } from "../lib/site-content";

export default function Home() {
  return (
    <>
      <section className="home-hero section-shell">
        <div className="hero-copy">
          <span className="eyebrow">Private AI · faithfully local</span>
          <h1>Your knowledge.<br /><em>Your computer.</em><br />Your Ranga.</h1>
          <p>Rangabot is a local-first personal assistant for conversation, learning, coding and analysis. Your chats, memories, documents and data stay with you.</p>
          <div className="hero-actions">
            <Link className="button button-gold" href="/download">Install from source <span>→</span></Link>
            <Link className="text-link" href="/showcase">See how it works <span>↗</span></Link>
          </div>
          <div className="trust-line"><span>Open source</span><span>Runs locally</span><span>No account</span><span>Cloud disabled by default</span></div>
        </div>
        <div className="hero-product" aria-label="Rangabot local chat product preview">
          <div className="window-bar"><i /><i /><i /><span>Rangabot · localhost</span></div>
          <Image src="/media/product-home.png" alt="Rangabot fresh chat interface with projects, local model controls and conversation starters" width={1280} height={720} priority />
          <div className="hero-ranga"><Image src="/ranga/ranga-idle.png" alt="Ranga, the golden retriever guide" width={192} height={208} /></div>
          <div className="local-seal"><strong>LOCAL</strong><span>Nothing sent</span></div>
        </div>
      </section>

      <section className="quiet-proof">
        <span>Your model</span><i />
        <span>Your memory</span><i />
        <span>Your documents</span><i />
        <span>Your boundaries</span>
      </section>

      <section className="section-shell story-intro">
        <span className="eyebrow">One companion, four paths</span>
        <div><h2>Useful because it knows<br />when to think—and when to ask.</h2><p>Rangabot adds a local control plane above the downloaded model: selecting context, respecting permissions, running verified tools and showing the evidence behind important answers.</p></div>
      </section>

      <section className="pillar-grid section-shell">
        {pillars.map((pillar) => (
          <Link className="pillar-card" href={pillar.href} key={pillar.eyebrow}>
            <span className="pillar-index">{pillar.mark}</span>
            <span className={`status status-${pillar.status.toLowerCase()}`}>{pillar.status}</span>
            <small>{pillar.eyebrow}</small>
            <h3>{pillar.title}</h3>
            <p>{pillar.text}</p>
            <span className="card-link">Explore the path <b>→</b></span>
          </Link>
        ))}
      </section>

      <section className="privacy-story section-shell">
        <div className="privacy-copy"><span className="eyebrow">Privacy is the architecture</span><h2>Local first is a boundary,<br />not a badge.</h2><p>Rangabot binds locally, rejects remote Ollama configuration, and keeps private data out of the public website. External help remains a future, permission-gated path.</p><Link className="text-link" href="/privacy">Read the privacy model <span>→</span></Link></div>
        <div className="privacy-diagram" aria-label="Rangabot local data flow">
          <div className="flow-person"><span>You</span></div>
          <span className="flow-line" />
          <div className="flow-core"><Image src="/ranga/ranga-idle.png" alt="" width={58} height={63} /><strong>Rangabot</strong><small>Local control plane</small></div>
          <div className="flow-orbit"><span>Local model</span><span>Knowledge vault</span><span>Approved data</span></div>
          <div className="flow-external">External service <small>Locked by default</small></div>
        </div>
      </section>

      <section className="showcase-split section-shell">
        <div><span className="eyebrow">Local intelligence</span><h2>Private books become clear, cited teaching.</h2><p>See what Rangabot retrieved, where it came from and which parts rely on model background.</p><Link className="text-link" href="/showcase">Open the product tour <span>→</span></Link></div>
        <div className="framed-shot"><Image src="/media/product-brief.png" alt="Rangabot Knowledge Brief with sourced local developments" width={1280} height={720} /></div>
      </section>

      <section className="evidence-band">
        <div className="section-shell evidence-head"><div><span className="eyebrow">Proof before promises</span><h2>Every claim has a trail.</h2></div><p>Scores name the suite, model and limitations. A merged feature is not automatically a mastered capability.</p></div>
        <div className="section-shell evidence-grid">
          {evidenceCards.map((card) => <article key={card.label}><strong>{card.value}</strong><h3>{card.label}</h3><p>{card.note}</p></article>)}
        </div>
        <div className="section-shell band-action"><Link className="button button-paper" href="/evidence">Inspect the evidence <span>→</span></Link></div>
      </section>

      <section className="mastery-teaser section-shell">
        <div className="mastery-copy"><span className="eyebrow">Path to Mastery</span><h2>The roadmap is alive.</h2><p>Forty-five public capability nodes show what is dependable, what is training and exactly what must pass next.</p><div className="mastery-stat"><strong>18%</strong><span>capability readiness<br /><small>8 of 45 fully unlocked · evidence checked 2 Aug 2026</small></span></div><Link className="button button-ink" href="/mastery">Enter the mastery tree <span>→</span></Link></div>
        <div className="framed-shot dark-shot"><Image src="/media/product-mastery.png" alt="Rangabot Path to Mastery public skill tree" width={1280} height={720} /></div>
      </section>

      <section className="community-call section-shell">
        <div><span className="eyebrow">Built by the pack</span><h2>Help a local companion grow.</h2><p>Choose a bounded capability, discuss the acceptance criteria, merge evidence and keep the achievement attached to the people who earned it.</p></div>
        <div className="community-actions"><Link className="button button-gold" href="/community">Find a contribution <span>→</span></Link><Link className="text-link" href={repositoryUrl}>View GitHub <span>↗</span></Link></div>
      </section>
    </>
  );
}
