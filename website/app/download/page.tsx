import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "../../components/PageHero";
import { repositoryUrl } from "../../lib/site-content";

export const metadata: Metadata = { title: "Download", description: "Install the Rangabot pre-release locally from source." };

export default function DownloadPage() {
  return (
    <>
      <PageHero eyebrow="Pre-release installation" title="Bring Ranga home." description="Rangabot currently installs from source. There is no native application package yet, and the website will not pretend otherwise." compact />
      <section className="download-panel section-shell">
        <article className="hardware-card"><span className="eyebrow">Before you begin</span><h2>A modest local setup.</h2><ul><li><strong>Node.js</strong><span>24 or newer</span></li><li><strong>Ollama</strong><span>Running locally</span></li><li><strong>Starter chat model</strong><span>llama3.2:3b</span></li><li><strong>Embedding model</strong><span>nomic-embed-text</span></li><li><strong>Server binding</strong><span>127.0.0.1</span></li><li><strong>Account</strong><span>Not required</span></li></ul><p className="install-note">Model quality and speed vary with hardware. Larger models are not automatically better for an undersized machine.</p></article>
        <article className="install-card"><span className="eyebrow">Recommended setup</span><h2>Install, inspect, then start.</h2><p>The setup guide helps select a local model and initialize private storage. Doctor verifies the runtime before the app opens.</p><div className="command-card">git clone {repositoryUrl}.git<br />cd rangabot<br />npm install<br />npm run setup<br />npm run doctor<br />npm run dev</div><div className="hero-actions"><Link className="button button-gold" href={repositoryUrl}>Open GitHub <span>↗</span></Link><Link className="text-link" href="/docs">Read setup guidance <span>→</span></Link></div></article>
      </section>
      <section className="section-shell callout"><strong>No silent model download.</strong><p>Rangabot setup explains the requested artifact and hardware guidance. Installing or replacing a large model remains an explicit user decision.</p></section>
    </>
  );
}
