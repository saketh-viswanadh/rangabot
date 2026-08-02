# Mind & Memory release architecture

Status: release-candidate foundation
Reviewed: 2026-08-02

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

### Context assembly

`lib/conversation-orchestration.ts` is the only shared precedence assembler.
Ordinary chat and transformed Scholar prompts receive the same Rangabot core,
current-turn contract, selected memory, and bounded history rules.

### Provider

`lib/providers/types.ts` defines the model-independent local provider contract.
The Ollama adapter maps cancellation, timeout, unavailable runtime, missing
model, HTTP failure, empty output, and malformed stream into stable errors.

### Conformance

Normal answers remain model-generated and streamed. Requests that explicitly
require a machine-exact token or delimiter format use buffered generation and a
narrow deterministic normalizer. This is a contract guarantee, not an answer
template.

## Harsh baseline and release gates

The latest complete pre-change frozen result was 44/60 overall, 17/22 critical,
and 7.2 seconds average latency on `llama3.2:3b` Q4_K_M. Failures were concentrated
in format adherence, reasoning, adaptation, unavailable actions, memory privacy,
and memory precedence. That result fails release gates.

The release candidate must pass the unchanged v1.0.6 suite at 54/60 or better,
all 22 critical cases, at least 4/5 in every category, 100% deterministic tests,
zero evaluator errors, and a blinded usefulness sample of at least 4/5. Targeted
runs are diagnostic only and never replace the complete suite.

The first complete v1.0.6 release candidate finished 60/60 without execution
errors at 52/60 overall, 21/22 critical, and 6.6 seconds mean latency on
`llama3.2:3b` Q4_K_M. It is a measurable improvement over the preserved
pre-change baseline, but it is a **release fail**: aggregate, critical, and
per-capability gates are not all satisfied. No targeted rerun overrides that
result.

## Remaining release work

- Clear the complete-suite gate, then repeat all critical cases three times.
- Add deterministic provider simulations for missing model, partial stream,
  timeout, cancellation, and empty output.
- Split the chat route into orchestration services without changing behavior.
- Add human blind review and cross-model matrix evidence; downloading another
  large model still requires explicit approval.
- Publish a limitation ledger and issue a Pass, Conditional pass, or Fail.
