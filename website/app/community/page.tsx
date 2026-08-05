import type { Metadata } from "next";
import { PageHero } from "../../components/PageHero";
import { repositoryUrl } from "../../lib/site-content";

export const metadata: Metadata = { title: "Community", description: "Contribute to Rangabot through bounded issues, evidence and reviewed achievements." };

export default function CommunityPage() {
  return (
    <>
      <PageHero eyebrow="Built by the pack" title="Craft one capability well." description="Rangabot grows through bounded work, explicit acceptance criteria and evidence. You do not need to understand the entire project to improve one honest part of it.">
        <a className="button button-gold" href={`${repositoryUrl}/issues`}>Find an issue <span>↗</span></a>
        <a className="text-link" href={`${repositoryUrl}/discussions`}>Join a discussion <span>↗</span></a>
      </PageHero>
      <section className="community-grid section-shell"><article><span className="eyebrow">Good first contribution</span><h2>Begin with a seam, not the whole system.</h2><p>Documentation repairs, accessibility checks, cross-platform tests and synthetic evaluation cases reveal how Rangabot works without requiring a major architecture change.</p><a className="text-link" href={`${repositoryUrl}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`}>Browse good first issues <span>↗</span></a></article><article><span className="eyebrow">Current focus</span><h2>Core reliability</h2><p>Conversation, memory, provider recovery, repeatability and honest evaluation are the foundation for every future mastery path.</p><a className="text-link" href="/mastery">See open gates <span>→</span></a></article><article><span className="eyebrow">Recognition</span><h2>Achievements remembered</h2><p>Opt-in contributor claims require merged evidence and official approval. Credit remains even if a capability later regresses.</p><a className="text-link" href={`${repositoryUrl}/issues/new?template=mastery-claim.yml`}>Request a claim <span>↗</span></a></article><article><span className="eyebrow">Project conduct</span><h2>Clear, kind review</h2><p>Challenge claims and architecture without diminishing the person doing the work. Safety and privacy concerns receive priority.</p><a className="text-link" href={`${repositoryUrl}/blob/main/CODE_OF_CONDUCT.md`}>Read the covenant <span>↗</span></a></article><article><span className="eyebrow">Development</span><h2>One command to verify</h2><p>Contributor setup, checks and supported environments are documented in the repository. Ubuntu and Windows CI guard every pull request.</p><a className="text-link" href={`${repositoryUrl}/blob/main/CONTRIBUTING.md`}>Contribution guide <span>↗</span></a></article></section>
      <section className="contribution-flow"><div className="section-shell"><span className="eyebrow">The contribution journey</span><h2>Discussion becomes evidence.</h2><div className="contribution-steps">{["Discuss", "Choose scope", "Build", "Validate", "Review", "Remember"].map((step, index) => <span key={step}><b>0{index + 1}</b>{step}</span>)}</div></div></section>
    </>
  );
}
