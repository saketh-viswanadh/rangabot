# Core Conversation Contract

Version: 1.3.0
Frozen benchmark: 2026-08-02
Lifecycle amendment: 2026-08-07
Semantic task-frame amendment: 2026-08-10

This contract defines what ordinary Rangabot conversation must do regardless of
which supported local Ollama model is selected. It is an orchestration and
product contract, not a claim that every model already satisfies it.

## Precedence

1. Safety and the local-first privacy boundary.
2. The user's current explicit request.
3. A correction in the current turn.
4. Relevant recent conversation.
5. Explicitly approved, relevant local memory.
6. Rangabot defaults.
7. Model defaults.

Current instructions always override saved memory. Unrelated memory must never
enter the prompt or answer.

The model-independent implementation is defined in the
[Mind & Memory release architecture](MIND_MEMORY_ARCHITECTURE.md). The contract
is assembled identically for ordinary chat and transformed Scholar prompts.

Before generation, a deterministic semantic task frame may preserve the current
turn's intent, exact named subject, audience, tone, depth, diagnostic context,
and directional count change. It treats extracted values as untrusted data and
adds only broad execution constraints. It must not encode benchmark answers,
invent domain knowledge, or override the precedence order above.

## Answer standard

An acceptable core answer is:

- direct, useful, natural, and appropriately concise;
- faithful to requested counts, length, format, exclusions, tone, and audience;
- consistent with relevant recent context and current corrections;
- explicit about material uncertainty and unavailable current data;
- honest about unavailable tools or actions;
- internally consistent and willing to correct a false premise;
- free of unrelated saved memories or claims about Rangabot's internal prompt.

Rangabot must never claim or imply that it completed an unavailable action.

## Turn lifecycle standard

Every saved request has one server-owned, durable turn identity. The browser may
submit only that identity after creation; it cannot replace canonical history or
author its own terminal state.

- At most one turn may be pending for a conversation.
- Retrying an ambiguous start reuses the same UUID and exact normalized request.
- Only a clean completed response atomically appends its user/assistant pair to
  canonical model history.
- Cancelled and failed turns retain an inspectable receipt and bounded partial,
  but never enter a later prompt, conversation search, or portable export.
- Stop propagates through the provider and any selected local tool. Cancellation
  is never retried, and a timeout is never mislabeled as user cancellation.
- A browser reload may adopt and observe a pending server turn. Unknown network
  state keeps ownership locked until an authoritative receipt is available.
- Project/dataset binding changes and destructive deletion are rejected while
  related work is pending.
- One absolute deadline bounds the turn. Stale recovery begins only after the
  maximum supported deadline and cannot convert partial output into history.

These rules are model-independent. They improve the reliability of every local
model but do not make a weak model's answer semantically correct.

## Frozen v1 benchmark

The tracked v1.0.13 suite contains 60 synthetic cases: five cases in each of twelve
capability groups.

1. Direct usefulness
2. Hard instruction and format adherence
3. Multi-turn continuity
4. Correction precedence
5. Honest uncertainty
6. False-premise correction and reasoning
7. Tone and audience adaptation
8. Relevant memory use
9. Memory privacy and irrelevant-memory exclusion
10. Memory conflict and current-turn precedence
11. Unavailable-action boundaries
12. Scope control and ambiguity judgment

The suite never reads real chats or the live memory database. Full answers stay
in `data/evaluations/results/`, which is Git-ignored. Fixtures, rules, schema,
and public-safe aggregate methodology are tracked.

## Acceptance gates

- Deterministic orchestration tests: 100%.
- Critical privacy and trust cases: 100% on every run.
- General end-to-end suite: at least 90% (`54/60`).
- Every capability group: at least 80% (`4/5`).
- Successful completion: at least 98%; no empty outputs or evaluator crashes.
- Correction handling: at least 95%.
- Explicit format adherence: at least 90%.
- Memory relevance precision: at least 95%.
- Memory relevance recall: at least 90%.
- Current-turn-over-memory precedence: 100%.
- False-premise correction: at least 90%.
- Fake-action and fabricated-live-data cases: 100%.
- Human blind usefulness sample: at least 4/5.

No acceptance criterion may be weakened, and no difficult case may be removed,
to improve a score. Targeted reruns are diagnostics, not complete-suite results.
Intermittent privacy or safety failures count as failures.

## Result provenance

Every result must record:

- suite name, schema version, and suite version;
- Git commit and dirty-tree state;
- mode (`baseline` or `candidate`);
- model name, model metadata when locally available, and configured context;
- Ollama version;
- operating system, architecture, CPU description, and total memory;
- Node version, cold/warm declaration, start/end times, timing, and errors;
- numerator and denominator overall and per capability group.

Changing a rubric requires a changelog entry explaining the defect, the change,
whether old outputs were rescored, and whether comparison remains valid.

## Known v1 limitation

Most automatic rules are deterministic surface checks. They catch exact format,
forbidden content, critical phrases, and known factual/calculation outcomes, but
they do not fully judge helpfulness, nuance, or semantic truth. That is why the
release gate also requires a blinded human sample and repeated critical cases.
Cases whose correctness cannot be established by deterministic structural rules
are explicitly marked for human semantic adjudication; their full-run and every
repeated critical answer must independently pass that human gate.
