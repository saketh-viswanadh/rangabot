# Mind & Memory release architecture

Status: release-candidate foundation
Reviewed: 2026-08-07

Mind & Memory is Rangabot's control plane. Scholar, Builder, Creator, and future
tools may add context or capabilities, but they must not invent their own rules
for instruction precedence, memory, provider execution, or truthfulness.

## Non-negotiable invariants

1. Safety and local-first privacy outrank every other instruction.
2. The current explicit request and correction outrank history and memory.
3. Only explicitly approved, relevant, non-conflicting memory enters a prompt.
4. Unavailable actions are rejected before probabilistic generation.
5. Hard output constraints are compiled once and applied in every mode.
6. Exact-format normalization is narrow, deterministic, and never rewrites
   ordinary prose.
7. Provider cancellation reaches the local runtime; cancellation is never retried.
8. Every provider failure has a stable typed category.
9. Private chats, live memories, and model answers never become public fixtures.
10. No model-specific answer, benchmark phrase, or question-specific production
    prompt is allowed.
11. Model-produced plans are proposals, never authority: each material field,
    filter, memory, constraint, and action must have inspectable provenance in
    the current request or an explicitly approved source.

## Request path

```text
validated request
  -> deterministic capability boundary
  -> current-turn answer contract
  -> relevant recent conversation
  -> conflict-aware approved-memory selection
  -> optional Scholar / Builder / Creator context transformation
  -> shared precedence and context assembly
  -> typed local provider
  -> narrow contract conformance where required
  -> streamed or buffered local response with an inspectable receipt
```

Tool-using paths add one model-independent boundary before execution:

```text
model interpretation proposal
  -> current-request provenance audit
  -> operation and capability contract
  -> deterministic normalization where evidence is unambiguous
  -> focused clarification where it is not
  -> bounded local execution
  -> evidence-grounded narration
```

This is the same precedence principle used by memory selection. A retrieved
memory or model-proposed filter may help only when relevant and non-conflicting;
neither may silently override the current request. The analytical validator is
the first executable proof of this shared proposal-audit pattern. It is not yet
evidence that the broader tool planner is reliable.

## Architectural responsibilities

### Request contract

`lib/conversation-contract.ts` extracts only explicit constraints: counts, word
limits, list style, exclusions, exact literals, current language, and tone. It
also owns deterministic unavailable-action boundaries. It does not infer hidden
intent or decide factual content.

### Memory

`lib/memories.ts` owns approved persistence, import conflict review, relevance,
and pre-prompt conflict exclusion. Memory is user-provided context, not verified
truth. A memory that conflicts with the current contract is excluded rather than
asking a small model to resolve the conflict correctly.

Universal style preferences and domain-scoped instructions are distinct.
Subject-scoped memory requires lexical or local topic-family agreement; explicit
current technical choices exclude conflicting saved preferences. Same-purpose
memories are resolved newest-first before ranking. The model-independent
`rangabot-memory-selection` suite measures this boundary directly and is run in
CI without reading the live memory database.

### Context assembly

`lib/conversation-orchestration.ts` is the only shared precedence assembler.
Ordinary chat and transformed Scholar prompts receive the same Rangabot core,
current-turn contract, selected memory, and bounded history rules.

### Provider

`lib/providers/types.ts` defines the model-independent local provider contract.
The Ollama adapter maps cancellation, timeout, unavailable runtime, missing
model, HTTP failure, empty output, and malformed stream into stable errors.
Generation receives one absolute deadline. Rangabot does not automatically
retry a timeout because it cannot prove that generation never began; recovery
requires an explicit new request. Deterministic simulations cover both buffered
and streaming failure categories.

### Conformance

Normal answers remain model-generated and streamed. Requests that explicitly
require a machine-exact token or delimiter format use buffered generation and a
narrow deterministic normalizer. This is a contract guarantee, not an answer
template.

### Proposal provenance

`lib/advanced-analytical-plan.ts` records why model-proposed fields were kept,
removed, replaced, or converted to clarification. It validates types, output
grain, Boolean intent, calendar boundaries, relation roles, and operation
requirements without domain table names. This audit pattern is a candidate for
future shared tool planning, but it must not be generalized into memory or other
paths until separate tests show that the abstraction preserves their contracts.

### Durable turn ownership

`lib/conversation-turns.ts` and `lib/chat-turn-lifecycle.ts` separate an
inspectable execution ledger from the canonical completed transcript. A
versioned start endpoint creates or replays one request-bound UUID; the chat
endpoint then claims only that stored turn and reconstructs its bounded context
server-side. Clean EOF commits one pair transactionally. Cancellation, timeout,
provider failure, empty output, malformed streams, and persistence rollback end
the ledger receipt without contaminating later model context.

The browser owns only presentation and cancellation intent. It retries an
ambiguous start with the same UUID, blocks a second send while ownership is
unknown, reconciles against the server, and polls boundedly after adopting a
pending turn on reload. Dataset/project binding mutation and deletion serialize
against pending work. Portable Markdown contains conversational text and reply
context only; local artifact IDs, dataset traces, model IDs, memory titles, and
internal turn receipts stay on their originating machine.

The migration is additive and validates the complete table, checks, foreign key,
indexes, and canonical marker transactionally. A failed or locked initialization
closes the handle so a later attempt can recover instead of caching a half-
migrated database.

Evaluation follows the same trust boundary: every gold query must execute before
the first model call. Evaluator defects invalidate affected cases and are never
reported as product failures or silently repaired into a better score.

## Harsh baseline and release gates

The latest complete pre-change frozen result was 44/60 overall, 17/22 critical,
and 7.2 seconds average latency on `llama3.2:3b` Q4_K_M. Failures were concentrated
in format adherence, reasoning, adaptation, unavailable actions, memory privacy,
and memory precedence. That result fails release gates.

The release candidate must pass the frozen v1.0.12 suite at 54/60 or better,
all 22 critical cases, at least 4/5 in every category, 100% deterministic tests,
zero evaluator errors, and a blinded usefulness sample of at least 4/5. Targeted
runs are diagnostic only and never replace the complete suite.

The first complete v1.0.6 release candidate finished 60/60 without execution
errors at 52/60 overall, 21/22 critical, and 6.6 seconds mean latency on
`llama3.2:3b` Q4_K_M. It is a measurable improvement over the preserved
pre-change baseline, but it is a **release fail**: aggregate, critical, and
per-capability gates are not all satisfied. No targeted rerun overrides that
result.

The preserved output rescored under the documented v1.0.7 semantic repair is
53/60 overall and 22/22 critical. It still fails the 54/60 aggregate gate and
the per-capability gates, so the release verdict remains **fail**.

## Remaining release work

- Repeat critical trust cases and complete the blinded human usefulness sample.
- Keep route-level lifecycle simulations in the release gate. Cancellation,
  timeout, partial/malformed/empty streams, unavailable/missing providers,
  ambiguous start replay, persistence rollback, destructive-mutation races and
  duplicate prevention are now covered deterministically.
- Split the chat route into orchestration services without changing behavior.
- Complete human blind review and a full cross-model matrix on approved hardware.
  Qwen2.5 7B was evaluated and removed from this 8 GB host after poor machine-fit
  evidence; its retained critical comparison is not a full matrix.
- Publish a limitation ledger and issue a Pass, Conditional pass, or Fail.

## Reviewer qualification boundary

Adaptive self-review is not enabled merely because a provider can emit JSON.
A reviewer model must first pass all 12 frozen qualification cases: it must fix
six materially wrong drafts and preserve six already-correct drafts without a
single regression. Structured output is schema-constrained locally, but schema
validity is not treated as semantic competence.

On 2026-08-02, `llama3.2:3b` passed only 1/12 forced reviewer cases. It approved
wrong arithmetic and p-value claims and rewrote several correct answers. The
reviewer therefore remains locked and is absent from the production response
path. This negative result prevents a superficially sophisticated quality stage
from making Rangabot slower and less reliable.

## Historical candidate evidence

The latest complete production-path run finished all 60 v1.0.7 cases without an
execution error at 56/60, 22/22 critical, and 8.3 seconds mean latency. The
preserved output rescored under the documented v1.0.8 semantic repair is 57/60;
every capability is at least 4/5. Three subsequent complete critical runs,
transparently rescored under v1.0.9, finished at 20/22, 22/22, and 22/22. The
first run genuinely failed false-premise correction and causal reasoning.
Because intermittent critical failures count as failures, the formal release
verdict at that stage was **fail**. Human review cannot override this gate.

The first candidate after premise-verification hardening passed a complete
22/22 critical run at 4.7 seconds mean latency. Its subsequent full 60-case run
rescored transparently under v1.0.11 to 56/60 and 22/22 critical at 6.7 seconds,
but reasoning finished at only 3/5 after incorrect class-imbalance and speedup
answers. The verdict therefore remains **fail** under the per-capability gate.

The verified-reasoning-ledger candidate then derived bounded speedup arithmetic
and equal-majority class baselines locally before generation. Three targeted
repeats passed 2/2. The unchanged complete v1.0.11 suite finished at 59/60,
22/22 critical, 5/5 reasoning, and 5.9 seconds mean latency, with every category
at least 4/5. This restores a **conditional pass**: repeated critical evidence
for this exact candidate and blinded human usefulness review remain required.

The 2026-08-03 memory-selection candidate adds a separate deterministic v1.0.0
audit. Its 24 synthetic scenarios improved from 73.3% precision (11/15) and
73.3% recall (11/15) to 100% (15/15) on both measures. At clean commit `594d57e`,
the unchanged v1.0.11 model suite completed 60/60 at 57/60 overall, 22/22
critical, and 6.6 seconds mean latency; memory use, privacy, and precedence were
each 5/5. This satisfies the memory gates for this run but does not complete the
release: repeated critical and blinded usefulness gates remain outstanding.

On clean implementation commit `f4b3677`, the unchanged v1.0.11 suite finished
at 59/60, 22/22 critical, and 6.5 seconds mean latency. One adaptation case used
polite wording forbidden by that fixture; every category remained at least 4/5.
An earlier dirty-tree lifecycle candidate was 58/60 and is retained rather than
hidden. The model suite uses the preserved stateless evaluator path, so it shows
that lifecycle work did not materially regress answer quality; it does not test
durable turn ownership. The latter is supported by deterministic route,
transaction, stream, cancellation, migration, and race simulations. That
historical candidate's verdict was **conditional pass** until repeated critical
and blind-human gates were complete.

The current v1.0.12 closeout candidate adds a provider-independent Semantic Task
Frame and a bound release-gate implementation. It has no accepted exact-candidate
full result, three-run critical result, or completed blind-human review yet. Its
release decision is therefore **pending**, not inherited from any v1.0.11 run.

On 2026-08-05, `qwen2.5:7b` also passed only 1/12 reviewer cases and remains
blocked. The first same-context critical comparison recorded 21/22 for both
Qwen and Llama. Qwen was 2.3x slower, but correctly rejected a material Python
false premise that Llama repeated. That narrow benefit did not outweigh its
memory pressure, latency and Teacher Mode failures on the 8 GB host, so the
local artifact was removed after testing. Registry support remains for
controlled comparisons on suitable hardware; automatic routing and reviewing
remain disabled. A complete cross-model suite has not yet run.
