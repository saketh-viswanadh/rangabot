import type { Metadata } from "next";
import { PageHero } from "../../components/PageHero";

export const metadata: Metadata = { title: "Privacy", description: "What Rangabot stores, what stays local and which actions remain locked." };

export default function PrivacyPage() {
  return (
    <>
      <PageHero eyebrow="Privacy architecture" title="Local by design. Permission by exception." description="The assistant runs on your computer, rejects remote model configuration and keeps every sensitive collection outside the public website and source history." compact />
      <section className="privacy-map section-shell">
        <article className="privacy-column"><span className="eyebrow">Stays local</span><h2>Your private material</h2><ul>{["Chats and project history", "Approved memories", "Knowledge Vault documents", "Embeddings and indexes", "Dataset contents", "Repository previews", "Generated artifacts", "Private evaluation answers"].map(item => <li key={item}>{item}</li>)}</ul></article>
        <article className="privacy-column"><span className="eyebrow">Explicit permission</span><h2>Local access boundaries</h2><ul>{["Repository allowlisting", "Dataset allowlisting", "Per-chat attachments", "On-demand file previews", "Memory approval", "Reversible access", "Visible calculation receipts", "Local backup and deletion"].map(item => <li key={item}>{item}</li>)}</ul></article>
        <article className="privacy-column"><span className="eyebrow">Locked by default</span><h2>External paths</h2><ul>{["Cloud model handoff", "Automatic web browsing", "Email access", "Calendar access", "Telemetry", "Remote Ollama servers", "Silent uploads", "Public model fallback"].map(item => <li key={item}>{item}</li>)}</ul></article>
      </section>
      <section className="content-section section-shell"><div className="section-heading"><div><span className="eyebrow">Honest threat model</span><h2>Local does not mean invulnerable.</h2></div><p>Malware or another user with host access may read local files. Models can still produce incorrect content. Approved repositories and datasets may contain sensitive information. Rangabot reduces network exposure; it cannot replace operating-system security or human review.</p></div><div className="feature-list"><article><span>01</span><h3>Loopback model</h3><p>Non-loopback Ollama URLs are rejected so configuration mistakes do not silently transmit prompts.</p></article><article><span>02</span><h3>Private storage</h3><p>Databases, vault material, approvals and artifacts are ignored by Git and omitted from website builds.</p></article><article><span>03</span><h3>Visible uncertainty</h3><p>Unavailable live data and unsupported actions must be stated rather than fabricated.</p></article></div></section>
    </>
  );
}
