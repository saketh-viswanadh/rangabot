import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "../../components/PageHero";

export const metadata: Metadata = { title: "Product", description: "Explore Rangabot's Mind, Memory, Scholar, Analyst and Builder capabilities." };

const sections = [
  {
    id: "mind",
    eyebrow: "Mind",
    title: "The model speaks. Rangabot decides what it should know.",
    description: "A model-independent control plane compiles the current request, recent context, relevant approved memory and capability boundaries into one inspectable answer contract.",
    items: [
      ["Instruction precedence", "Safety and the current request always outrank stale context, memory and model defaults."],
      ["Bounded context", "Only useful recent conversation is carried forward, avoiding unlimited prompt growth."],
      ["Truthful capability", "Unavailable actions and live information are stated honestly instead of being simulated."],
    ],
  },
  {
    id: "memory",
    eyebrow: "Memory",
    title: "Remember deliberately. Forget completely.",
    description: "Memories are explicit local records with origin, confidence and controls. A normal conversation does not silently become a permanent fact.",
    items: [
      ["Approval first", "The user decides what becomes reusable memory."],
      ["Topic-aware selection", "Unrelated personal facts stay out of the prompt and response."],
      ["Inspectable control", "Review, edit, export, supersede or delete local memory."],
    ],
  },
  {
    id: "scholar",
    eyebrow: "Scholar",
    title: "A private library that knows where an answer came from.",
    description: "The Knowledge Vault extracts supported documents locally, combines keyword and embedding search, and gives the model bounded source passages for teaching and synthesis.",
    items: [
      ["Hybrid retrieval", "Keyword precision and semantic similarity work together with a visible fallback."],
      ["Source locators", "Answers cite the document, passage and available page or section context."],
      ["Evidence separation", "Vault-supported claims remain distinct from downloaded-model background."],
    ],
  },
  {
    id: "analyst",
    eyebrow: "Analyst · experimental",
    title: "Ask in ordinary language. Inspect the calculation.",
    description: "With explicit read-only access, Rangabot identifies when computation is required, compiles a constrained analytical plan and explains the verified local result.",
    items: [
      ["Permission boundary", "A file must be allowlisted and attached to the current conversation."],
      ["Bounded execution", "Only validated read-only SQL runs inside local DuckDB resource limits."],
      ["Visible receipt", "Dataset, query, row count, timing and fingerprints stay available for review."],
    ],
  },
  {
    id: "builder",
    eyebrow: "Builder",
    title: "Bring the right piece of a repository into the conversation.",
    description: "Rangabot searches only approved folders, skips common secret and dependency paths, and attaches bounded file previews to local-model chat.",
    items: [
      ["Scoped repository access", "Approvals are explicit, reversible and stored only on the local device."],
      ["On-demand context", "There is no hidden background repository index."],
      ["Creation with checks", "Word creation gathers requirements in chat, validates output and can render local previews."],
    ],
  },
] as const;

export default function ProductPage() {
  return (
    <>
      <PageHero eyebrow="The product" title="More than a model in a chat window." description="Rangabot coordinates private models, approved knowledge, selective memory and bounded local tools—then exposes enough of the process to earn trust.">
        <Link className="button button-gold" href="/showcase">Take the product tour <span>→</span></Link>
        <Link className="text-link" href="/mastery">See what remains <span>↗</span></Link>
      </PageHero>
      {sections.map((section, index) => (
        <section className="content-section section-shell" id={section.id} key={section.id}>
          <div className="section-heading"><div><span className="eyebrow">{section.eyebrow}</span><h2>{section.title}</h2></div><p>{section.description}</p></div>
          <div className="feature-list">{section.items.map(([title, text], itemIndex) => <article key={title}><span>{String(index + 1).padStart(2, "0")}.{itemIndex + 1}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
        </section>
      ))}
      <section className="section-shell callout"><strong>Pre-release means the boundaries are real—and the quality gates are still being earned.</strong><p>Available, experimental and planned abilities are labelled separately. Visit Evidence for exact results or Path to Mastery for criterion-level progress.</p></section>
    </>
  );
}
