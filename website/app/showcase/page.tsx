import type { Metadata } from "next";
import Image from "next/image";
import { PageHero } from "../../components/PageHero";

export const metadata: Metadata = { title: "Showcase", description: "A synthetic, privacy-safe tour of Rangabot's local workflows." };

export default function ShowcasePage() {
  return (
    <>
      <PageHero eyebrow="Synthetic product tour" title="See the work, without surrendering the data." description="Every example below is scripted with fictional people, documents and datasets. This page does not send prompts, upload files or contact a model." />
      <section className="showcase-story section-shell">
        <article className="showcase-row">
          <div className="showcase-copy"><span>01 · Mind & Memory</span><h2>A correction outranks an old preference.</h2><p>Rangabot selects only relevant memory and makes the source visible. The user remains in control of what persists.</p></div>
          <div className="scripted-chat"><span className="chat-meta">Synthetic conversation · local</span><div className="chat-bubble user">Remember that I prefer concise explanations for work topics.</div><div className="chat-bubble">I can save that as a local preference. You can inspect, change or delete it at any time.</div><div className="chat-bubble user">For this lesson, explain it slowly with examples.</div><div className="chat-bubble">Absolutely. Your current instruction overrides the concise-work preference for this lesson.</div><div className="trace">Memory used: explanation preference · current-turn override: active</div></div>
        </article>
        <article className="showcase-row">
          <div className="showcase-copy"><span>02 · Scholar</span><h2>Books provide evidence. The model provides a voice.</h2><p>The answer can combine retrieved passages across local documents while marking what is sourced and what is general model background.</p></div>
          <div className="framed-shot"><Image src="/media/product-brief.png" alt="Synthetic Rangabot Knowledge Brief with sources and vault status" width={1280} height={720} /></div>
        </article>
        <article className="showcase-row">
          <div className="showcase-copy"><span>03 · Analyst</span><h2>The number comes from execution—not invention.</h2><p>Rangabot uses the approved schema to plan a read-only query, runs it locally and keeps the calculation attached to the answer.</p></div>
          <div className="scripted-chat"><span className="chat-meta">Synthetic academy.duckdb · read only</span><div className="chat-bubble user">How many distinct students studied Python at least once?</div><div className="chat-bubble">127 distinct students attended at least one Python course.</div><div className="trace">SELECT COUNT(DISTINCT e.student_id)<br />FROM enrollments e JOIN courses c USING (course_id)<br />WHERE lower(c.subject) = &apos;python&apos;;<br /><br />Verified result: 127 · 34 ms</div></div>
        </article>
        <article className="showcase-row">
          <div className="showcase-copy"><span>04 · Builder</span><h2>Repository context stays narrow and revocable.</h2><p>Rangabot reads an approved preview only when requested, revalidates it before sending and gives it solely to the downloaded local model.</p></div>
          <div className="scripted-chat"><span className="chat-meta">Approved repository · three files attached</span><div className="chat-bubble user">Explain how provider failures reach the chat interface.</div><div className="chat-bubble">The provider maps runtime failures into typed errors. The chat route converts those into recoverable user-visible states while preserving cancellation and preventing a hidden second attempt.</div><div className="trace">Context: lib/providers/types.ts · lib/providers/ollama.ts · app/api/chat/route.ts</div></div>
        </article>
      </section>
    </>
  );
}
