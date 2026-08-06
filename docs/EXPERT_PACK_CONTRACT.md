# Expert Pack Contract

- Contract version: 1.2.0
- Manifest schema: 1
- Status: approved architecture; Analytics reference implementation experimental

## Purpose

Expert Packs let people extend one local Rangabot with only the capabilities
they need. A pack is a governed workflow made from bounded tools, permissions,
resource declarations, model policy, evidence interfaces and an unchanged
qualification suite. It is not a prompt bundle, an autonomous personality or a
claim that an installed model is competent.

Mind & Memory remains the only control plane. It owns privacy, instruction
precedence, conversation continuity, approved memory, permission grants,
provider behavior and final answer synthesis. Packs receive a bounded request
and return a typed proposal plus inspectable evidence. They cannot silently add
memory, permissions, web access, files, models or user-visible actions.

## Non-negotiable invariants

1. Safety and local-first privacy outrank pack instructions and model output.
2. The current request and current-turn correction outrank history and memory.
3. A pack may use only permissions granted for the current request or persistent
   scope; declaring a permission in a manifest does not grant it.
4. Model-produced plans are proposals. Trusted code validates every executable
   field and material action against the current request and approved context.
5. Packs return evidence and a response proposal; Mind & Memory owns the final
   coherent response.
6. Packs never create hidden memory. Persisting a finding requires a separate,
   visible, provenance-bound approval flow.
7. Web access is disabled unless the Research boundary has an approved domain,
   exact query preview and current authorization.
8. On constrained hardware, v1 permits at most one loaded generative model.
9. Cancellation is terminal for the current attempt and is never retried
   silently.
10. Qualification is pack-and-model specific. A general model score cannot
    qualify a model for analytics, scholarship, documents, building or review.
11. Private documents, datasets, repositories, memories, prompts and answers
    never enter public pack fixtures or published benchmark evidence.
12. Uninstall preserves user data by default and clearly separates removable
    pack artifacts from user-owned content.

## Manifest

`lib/expert-packs.ts` is the executable schema boundary. Every manifest declares:

- stable lowercase pack id, semantic version and schema version;
- honest maturity: `design`, `experimental` or `qualified`;
- bounded capabilities, tools and capability-scoped permissions;
- `automatic`, `general` and `custom` model-selection support;
- minimum context, structured-output and tool-calling requirements;
- download, working-memory and unload estimates;
- frozen qualification suite and strict critical-case gate; and
- a privacy-preserving uninstall contract.

Unknown fields are rejected in v1. This makes security-sensitive additions an
explicit contract revision instead of permissive configuration drift.

## Model assignment

Every pack supports three saved choices:

- **Automatic** selects the best installed model qualified for that pack and
  compatible with the current machine.
- **General** reuses Rangabot's conversation model when it passes the pack gate.
- **Custom** selects an installed model explicitly and shows its pack-specific
  compatibility status.

A one-request override is recorded in the execution receipt and never changes
the saved assignment. Compatibility has five honest states: `qualified`,
`experimental`, `poor-fit`, `incompatible` and `not-installed`. Experimental
use is visible; it cannot unlock mastery or become a published recommendation.

Automatic selection follows this order:

1. qualified for the requested pack and supported capability;
2. fits available memory and minimum context;
3. already loaded, when quality is equivalent;
4. stronger unchanged-suite evidence;
5. lower measured switching and generation cost.

No automatic choice may download a model, bypass a memory-fit guard or weaken a
qualification threshold.

The Analytics `0.1.0` reference implements the contract surface but does not yet
implement saved per-pack selection or model switching. `General` explicitly
passes the configured local model to the provider. `Automatic` currently reuses
that same model and remains experimental. `Custom` fails before dataset or model
access unless it names the already configured model. No mode downloads or loads
another model, and none is represented as qualified.

## Resource lifecycle

The router prepares an inspectable execution plan before loading a specialist.
It reports selected packs, selected models, required tools, permissions, model
switch count and whether the internet is disabled.

Model files may coexist on disk. Generative models execute sequentially on
memory-constrained machines. Rangabot unloads an inactive model after the pack's
bounded idle period and unloads the previous large model before loading another.
Embedding models and deterministic runtimes are tracked separately from
generative weights. A plan fails safely when no qualified configuration fits.

## Request boundary

An `ExpertPackRequest` contains:

- request, conversation, pack, version and capability identities;
- the exact current user request;
- bounded user/assistant conversation content selected by Mind & Memory;
- resource-scoped, request- or conversation-bound permission grants;
- saved or one-request model assignment; and
- bounded references to the exact approved resources covered by those grants.

Mind & Memory constructs this request from saved local state. The Analytics pack
cannot mint grants: the chat control plane verifies the saved conversation's
dataset attachment, discards client-supplied prior history, adds only the current
user turn when needed, and issues grants for that dataset and request. The pack
resolves referenced content only through approved capability adapters. A title
or identifier is not permission to open arbitrary local content. Cancellation
is a trusted runtime signal and is deliberately not serialized into the request.

## Result and evidence boundary

An `ExpertPackResult` has one of four states: `success`, `clarification`,
`failure` or `cancelled`. It may include a response proposal, but the proposal
is not the final answer.

Evidence declares a kind, approved source, locator and bounded claims. Local
execution evidence additionally binds the approved dataset id, input hash,
query hash, read-only and no-external-access flags, row limit, returned row count,
truncation and duration. Model background is kept separate from evidence and
requires an inspectable model receipt. A successful result must contain
evidence. Typed warnings reveal when model narration was unavailable or rejected
by the grounding audit instead of silently presenting deterministic fallback as
model prose. Receipts disclose exact grant ids, permissions, tools, resolved
model and model switches. Stable errors distinguish
permission, capability, qualification, resource, timeout, cancellation, tool
and output failures.

Packs exchange this typed envelope rather than hidden free-form conversations.
That permits several packs to collaborate without allowing one model's prose to
become another pack's trusted input.

## Routing boundary

Routing uses deterministic evidence before model classification:

- attached approved data suggests Analytics;
- an approved repository and implementation request suggests Builder;
- vault-backed teaching or citation requests suggest Scholar;
- an explicit artifact request suggests Documents; and
- approved current-web research suggests Research.

If a material route remains ambiguous, Rangabot asks one focused clarification.
It does not silently execute a tool, access a file, switch to the web or install
a model.

## Qualification and maturity

A pack is `design` while its interfaces or gates are unproved. It becomes
`experimental` only after deterministic contract, privacy, cancellation and
failure tests pass. It becomes `qualified` only when its complete unchanged
suite, repeated critical partition, supported model matrix and human usefulness
gate pass with no critical regression.

Each pack reports numerator and denominator, suite version, Rangabot commit,
pack version, model profile, context, hardware, cold/warm state, latency and
errors. Targeted diagnostics never replace a complete score. Changing a rubric
requires a governed evaluator changelog and an explicit comparability decision.

## Reference implementation order

1. Keep Core Conversation Reliability as the release gate for Mind & Memory.
2. Convert existing read-only Analytics into the first reference pack without
   changing its execution behavior.
3. Add per-pack saved model assignment and request-level override.
4. Implement resource planning and one-model lifecycle enforcement.
5. Extract Scholar, Documents and Builder behind the proven boundary.
6. Keep Research locked until domain allowlisting, exact query preview and
   immediate revocation are complete.

The first reference conversion must prove that the pack boundary does not
duplicate memory, loosen dataset permissions, trust model-authored SQL or reduce
the unchanged analytical benchmark.

## Analytics reference implementation 0.1.0

The bundled Analytics manifest is immutable, local-only and honestly marked
`experimental`. The deterministic chat intent gate and route precedence are
unchanged. Mind & Memory verifies the saved conversation attachment and issues
the scoped request. The adapter then:

1. resolves only the exact allowlisted dataset id;
2. pins its identity before schema inspection;
3. sends only schema and bounded conversation content to the explicit local
   model when deterministic planning is insufficient;
4. routes final and categorical-grounding queries through one injected,
   cancellable DuckDB adapter with the pinned input hash;
5. accepts only trusted-code compiled read-only SQL;
6. numerically audits narration and falls back to the verified result table; and
7. returns a validated result, evidence receipt and backward-compatible trace.

DuckDB runs behind an isolated child-process boundary. Its absolute deadline
covers identity hashing, import, statement preparation and execution; Stop or a
timeout terminates a stuck native process instead of waiting indefinitely for an
interrupt that may never settle. The HTTP seam independently verifies that the
trace query hash, input hash, row count, truncation, duration, pack identity and
model identity match the validated result before exposing provenance to the UI.
The client applies the same bounded trace validator before saving it.

The chat route accepts the validated proposal as the response without a second
model synthesis step. This preserves the established analytical answer behavior
and latency while keeping authority in the control plane. It is a deliberately
narrow v0.1 behavior-preserving adapter, not autonomous pack collaboration.

The sealed astronomy transfer suite was rerun through the complete pack adapter
without changing its 12 cases, semantic rubric or gold results. Runner `2.0.0`
now scores the user-visible answer, evidence, grants, permissions, tool receipt,
model receipt and terminal envelope in addition to semantic plan and executed
result equality. It records the exact commit, dirty state, pack/model profile,
context, Ollama version, hardware, cold/warm state, timing and errors.

The clean warm-state run at commit `0a127445e7d07c52ece641eb912df82f560e5a6a`
remained 10/12 (83.3%): one exact-source semantic miss and one terminal invalid
conditional-rate plan. All 12 pack-envelope audits passed and the evaluator had
zero execution errors. Mean latency was 5.7 seconds, median 5.6 seconds and P95
14.4 seconds on the recorded Apple M1 8 GB / Llama 3.2 3B Q4_K_M profile at a
4096-token context. Six cases used grounded model narration, five visibly used
the verified fallback after narration rejection, and one ended in a typed pack
failure. This is below the manifest's 90% gate and is not a human-usefulness or
cross-model qualification. The pack cannot be called qualified or unlock
mastery. Saved model assignment, automatic selection, custom switching,
lifecycle management, qualification storage, installation and Python execution
remain incomplete.

## Deliberately deferred

- third-party pack signing, trust roots and revocation;
- automatic model downloading;
- remote pack registries;
- pack-authored UI surfaces;
- parallel large-model execution;
- autonomous pack-to-pack delegation; and
- public publication of any private evaluation material.

These require separate decisions and threat modelling. They are not implied by
the v1 types or roadmap approval.
