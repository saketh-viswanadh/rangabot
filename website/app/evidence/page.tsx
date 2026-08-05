import type { Metadata } from "next";
import { PageHero } from "../../components/PageHero";
import { repositoryUrl } from "../../lib/site-content";

export const metadata: Metadata = { title: "Evidence", description: "Exact Rangabot benchmark results, provenance and open release gates." };

const scores = [
  ["Core conversation candidate", "59/60", "v1.0.11 · llama3.2:3b · complete run", "Conditional"],
  ["Critical trust cases", "22/22", "One complete run; repetition still required", "Pass"],
  ["Reasoning cases", "5/5", "Same candidate and frozen rubric", "Pass"],
  ["Memory relevance precision", "15/15", "Synthetic selection audit", "Pass"],
  ["Memory relevance recall", "15/15", "Synthetic selection audit", "Pass"],
  ["Teacher answer quality", "50/60", "Latest recorded public result", "Below gate"],
  ["Teacher grounding", "54/60", "90%; target is at least 95%", "Below gate"],
  ["Analytical transfer", "10/12", "Frozen astronomy holdout", "Below gate"],
] as const;

export default function EvidencePage() {
  return (
    <>
      <PageHero eyebrow="Evidence ledger" title="Numbers with names, dates and limits." description="Rangabot reports numerator and denominator, suite version, model, hardware context and execution errors. Targeted reruns never become complete-suite claims." compact />
      <section className="content-section section-shell">
        <div className="score-table"><div className="score-row score-head"><span>Capability</span><span>Result</span><span>Evidence scope</span><span>State</span></div>{scores.map(([name, score, scope, state]) => <div className="score-row" key={name}><strong>{name}</strong><span>{score}</span><p>{scope}</p><span className={`score-state ${state === "Pass" ? "pass" : state === "Below gate" ? "below" : ""}`}>{state}</span></div>)}</div>
        <div className="evidence-note"><div><span className="eyebrow">What this proves</span><h2>A candidate, not a universal promise.</h2></div><p>Model behavior varies by model, quantization, context, hardware and run. These results describe exact evaluated candidates. They do not imply that every Ollama model will match them.</p></div>
      </section>
      <section className="section-shell callout"><strong>Private fixtures stay private.</strong><p>Full model answers, personal chats, saved memories, document titles and Knowledge Vault files remain Git-ignored. Public methodology and aggregate results are reviewable.</p><a className="text-link" href={`${repositoryUrl}/blob/main/docs/CORE_CONVERSATION_CONTRACT.md`}>Read the frozen contract <span>↗</span></a></section>
    </>
  );
}
