# Expert Pack Contract

- Contract version: 1.0.0
- Manifest schema: 1
- Status: proposed for merge approval

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

- request, pack and version identities;
- the exact current user request;
- capability-scoped permission grants;
- saved or one-request model assignment; and
- title-only references to approved context.

The pack resolves referenced content only through Mind & Memory's approved
capability adapters. A title or identifier is not permission to open arbitrary
local content.

## Result and evidence boundary

An `ExpertPackResult` has one of four states: `success`, `clarification`,
`failure` or `cancelled`. It may include a response proposal, but the proposal
is not the final answer.

Evidence declares a kind, approved source, locator and bounded claims. Model
background is kept separate from evidence. Receipts disclose permissions used,
tools used, resolved model and model switches. Stable errors distinguish
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
