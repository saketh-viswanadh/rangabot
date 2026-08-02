# Core Conversation Contract

Version: 1.0.0
Frozen: 2026-08-02

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

## Frozen v1 benchmark

The tracked v1 suite contains 60 synthetic cases: five cases in each of twelve
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
