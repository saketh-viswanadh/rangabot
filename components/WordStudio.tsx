"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";

type ArtifactResult = {
  id: string;
  title: string;
  filename: string;
  documentUrl: string;
  previewUrls: string[];
  checks: Array<{ id: string; label: string; status: "passed" | "warning"; detail: string }>;
};

export function WordStudio({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [documentType, setDocumentType] = useState("report");
  const [audience, setAudience] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tone, setTone] = useState("professional");
  const [sourceNotes, setSourceNotes] = useState("");
  const [artifact, setArtifact] = useState<ArtifactResult | null>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

  async function createDocument(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setMessage("Rangabot is drafting, formatting, validating and rendering locally…");
    setArtifact(null);
    try {
      const response = await fetch("/api/artifacts/word", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: { title, documentType, audience, purpose, tone, sourceNotes } }),
      });
      const data = (await response.json()) as { artifact?: ArtifactResult; error?: string };
      if (!response.ok || !data.artifact) throw new Error(data.error ?? "Could not create the document.");
      setArtifact(data.artifact);
      setMessage("Your local Word document is ready for review.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the document.");
    } finally {
      setCreating(false);
    }
  }

  return <div className="artifact-backdrop" onMouseDown={onClose}>
    <aside className="word-studio" role="dialog" aria-modal="true" aria-labelledby="word-studio-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="word-studio-header">
        <div><span>Local artifact skill · A1</span><h2 id="word-studio-title">Word Studio</h2><p>Create a polished DOCX from a structured brief. Nothing leaves this computer.</p></div>
        <button type="button" onClick={onClose} aria-label="Close Word Studio">×</button>
      </header>
      <div className="word-studio-body">
        <form className="word-brief" onSubmit={createDocument}>
          <label><span>Document title</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required placeholder="Quarterly analytics proposal" /></label>
          <div className="word-brief-row">
            <label><span>Document type</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value)}><option value="report">Report</option><option value="proposal">Proposal</option><option value="meeting-notes">Meeting notes</option><option value="technical-brief">Technical brief</option></select></label>
            <label><span>Tone</span><select value={tone} onChange={(event) => setTone(event.target.value)}><option value="professional">Professional</option><option value="executive">Executive</option><option value="friendly">Friendly</option><option value="technical">Technical</option></select></label>
          </div>
          <label><span>Audience</span><input value={audience} onChange={(event) => setAudience(event.target.value)} maxLength={240} required placeholder="Leadership team and analytics engineers" /></label>
          <label><span>Purpose</span><textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={600} required rows={3} placeholder="Explain the decision this document should support." /></label>
          <label><span>Source notes</span><textarea value={sourceNotes} onChange={(event) => setSourceNotes(event.target.value)} maxLength={20000} required rows={9} placeholder="Paste facts, requirements, decisions and source material. Rangabot is instructed not to invent missing details." /></label>
          <div className="word-privacy-note"><strong>Private workflow</strong><span>Drafting uses your configured Ollama model. Files and previews stay in <code>data/artifacts/</code>.</span></div>
          <button className="word-create-button" type="submit" disabled={creating}>{creating ? "Creating locally…" : "Create Word document"}</button>
          {message && <p className="word-status" role="status">{message}</p>}
        </form>
        <section className="artifact-review" aria-label="Document review">
          {!artifact && <div className="artifact-empty"><span>W</span><strong>Preview and quality report</strong><p>Your rendered pages and validation checks will appear here.</p></div>}
          {artifact && <>
            <div className="artifact-result-heading"><div><span>Ready locally</span><h3>{artifact.title}</h3><small>{artifact.filename}</small></div><a href={artifact.documentUrl}>Download .docx</a></div>
            <div className="artifact-checks">{artifact.checks.map((check) => <div key={check.id} className={check.status}><i aria-hidden="true">{check.status === "passed" ? "✓" : "!"}</i><span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>
            {artifact.previewUrls.length ? <div className="artifact-pages">{artifact.previewUrls.map((url, index) => <figure key={url}><Image src={url} alt={`Rendered page ${index + 1} of ${artifact.title}`} width={850} height={1100} unoptimized /><figcaption>Page {index + 1}</figcaption></figure>)}</div> : <div className="artifact-preview-warning">Visual rendering is unavailable. Review the downloaded file in Word before final use.</div>}
          </>}
        </section>
      </div>
    </aside>
  </div>;
}
