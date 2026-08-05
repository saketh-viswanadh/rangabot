import type { Metadata } from "next";
import { docsGroups, repositoryUrl } from "../../lib/site-content";
import { PageHero } from "../../components/PageHero";

export const metadata: Metadata = { title: "Documentation", description: "Task-based Rangabot setup and usage documentation." };

export default function DocsPage() {
  return (
    <>
      <PageHero eyebrow="Documentation" title="Start small. Stay in control." description="Install a local model, verify the privacy boundary, begin a conversation, then add memory, documents or tools only when you need them." compact />
      <section className="docs-layout section-shell">
        <aside className="docs-aside"><span className="eyebrow">First run</span><h2>Five calm steps.</h2><p>Rangabot currently installs from source. The guided setup checks the model, creates private storage and keeps the server bound to your computer.</p><div className="command-card">git clone {repositoryUrl}.git<br />cd rangabot<br />npm install<br />npm run setup<br />npm run doctor<br />npm run dev</div><p>Then open <code>http://127.0.0.1:3000</code>.</p></aside>
        <div className="docs-groups">{docsGroups.map(group => <article className="docs-card" key={group.title}><span className="eyebrow">Guide</span><h2>{group.title}</h2>{group.links.map(link => <a href={`${repositoryUrl}#${link.toLowerCase().replaceAll(" ", "-")}`} key={link}>{link}</a>)}</article>)}</div>
      </section>
      <section className="section-shell callout"><strong>Documentation is moving into this website.</strong><p>Version one links to the canonical repository guides so the public site cannot drift ahead of the code. Searchable native documentation is the next website increment.</p></section>
    </>
  );
}
