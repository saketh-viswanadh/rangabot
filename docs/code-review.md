# Critical code and repository review

Last reviewed: 2026-08-02

This is a release-blocking review of the tracked source tree, runtime boundaries,
dependencies, tests, documentation, and public GitHub configuration. Private
Knowledge Vault content and generated evaluation answers were not read or
published. Findings are kept here so cleanup is measurable rather than implied.

## Verified strengths

- Production and development servers bind to `127.0.0.1` by default.
- Ollama chat and embedding endpoints are now rejected unless they resolve from
  an explicitly loopback URL configuration.
- Chats, repository approvals, artifacts, vault documents, databases,
  embeddings, backups, and evaluation results are Git-ignored.
- Repository access is explicit, canonicalized, bounded, symlink-safe, and now
  blocks both common secret-bearing filenames and high-confidence secret content.
- GitHub `main` is protected, requires Linux and Windows CI, requires resolved
  conversations, blocks force pushes and deletion, and enforces administrators.
- GitHub secret scanning, push protection, Dependabot security updates,
  Discussions, Issues, and private vulnerability reporting are enabled.
- Production dependency audit currently reports zero vulnerabilities.

## Fixed in this review

### 2026-08-02 public truth and evaluation audit

- Replaced the stale README hero screenshot, which showed an obsolete sidebar
  and Ollama offline, with the maintained Rangabot social banner.
- Added a visible pre-release reliability qualification so the public feature
  list is not mistaken for a mastery or quality guarantee.
- Rejected the earlier 18/20 conversation result as an exhaustive score: the
  suite was small and unbalanced, reasoning failed 0/2, rules were primarily
  substring checks, and result provenance omitted the suite, commit, model,
  Ollama, context, hardware, completion state, and capability denominators.
- Froze a versioned 60-case contract with five cases in each of twelve core
  capabilities, explicit critical trust cases, provenance, and non-negotiable
  release gates. Semantic quality still requires blinded human review.
- Two complete 60/60 diagnostics exposed stochastic case variance and a strict
  1.0.2 score of 51/60 overall, 21/22 critical trust cases, and 7.2-second mean
  latency on the installed 3B model after equivalent-answer rubric repairs.
  Format, reasoning, adaptation/concision, and memory precedence are not at the
  release threshold; this is a conditional development baseline, not mastery.

### 2026-08-02 maintenance pass

- Removed the tracked generated `next-env.d.ts` file and made type checking run
  `next typegen` first, matching current Next.js guidance and ending development-
  versus-production import churn.
- Centralized runtime product identity and repository links in
  `config/product.json`; runtime model defaults now derive from the reviewed model
  registry instead of duplicating model IDs in TypeScript.
- Enabled unused-local and unused-parameter TypeScript checks and removed the
  first stale import they exposed.
- Removed unused GIF, sprite-atlas and stale screenshot payloads while preserving
  the PNG actually rendered by Rangabot and its CSS motion.
- Deferred the Memory panel and Markdown/highlighting stack until first use. In
  the audited production build, the main application-specific client chunk fell
  from roughly 362 KB to 57 KB and the 301 KB renderer became an on-demand chunk.
- Marked private vault, artifact, registry and user-selected repository filesystem
  reads as runtime-only for Turbopack tracing. The production build is now warning-
  free instead of accidentally tracing the whole project.
- Updated React type patch releases. All production dependencies remain used;
  unsupported Node, TypeScript and ESLint major upgrades were deliberately not forced.
- Enabled automatic merged-branch deletion, removed only remote branches proven
  merged into `main`, and closed two GitHub issues whose acceptance criteria are
  already implemented.

### Critical

- Removed the contradictory `gpt-oss:20b` runtime fallback. The documented,
  setup-selected lightweight fallback is consistently `llama3.2:3b`.
- Prevented a configured remote `OLLAMA_BASE_URL` from silently receiving chats,
  code previews, or vault evidence. Only HTTP loopback targets are accepted.

### High

- Replaced duplicate, inconsistent chat validators with one bounded validator:
  at most 200 messages, 50,000 characters per message, and 1,000,000 aggregate
  characters per request.
- Stopped answer-evaluation timeouts from being averaged into quality and latency
  metrics. Interrupted runs now report completed-case quality plus a conservative
  overall pass floor.
- Added high-confidence content scanning before repository files can be searched
  or previewed.
- Removed the LibreOffice previewer's mutation of the subprocess `HOME` variable;
  it now uses LibreOffice's scoped user-installation argument.

### Medium

- Centralized chat-model, embedding-model, local endpoint, and vault-budget
  defaults with validation.
- Added a bounded timeout to live query embedding.
- Added defensive browser headers against framing, cross-origin resource reads,
  referrer leakage, and unneeded device permissions.
- Corrected the stale pre-rename GitHub Discussions link.
- Updated `pdfjs-dist` from 6.1.200 to 6.2.108.
- Made embedding degradation visible per answer as `HYBRID` or `KEYWORD ONLY`.
- Replaced direct route-level Ramayana branching with a registered story-pack
  interface, retaining the curated safety fallback without coupling it to chat.
- Added a strict regression that rejects the observed data-leakage/concept-drift
  conflation. Broader entailment verification remains open below.

## Open findings

### High priority

1. **Grounding is lexical, not entailment-aware.** A paragraph can share words
   with a passage while contradicting it. The measured leakage-versus-concept-
   drift confusion proves this is not theoretical. Add concept-distinction and
   contradiction regression gates before describing grounded output as factual.
2. **First-draft evidence structure remains weak.** The fresh partial benchmark
   required deterministic evidence/background separation for most completed
   answers. It is safe, but it means the model is still failing the requested
   citation structure on its first attempt.
3. **Local API access has no application authentication.** Loopback binding and
   same-origin browser controls are appropriate for the current single-user
   design, but any other process running as the user can call the APIs. Network
   binding must remain prohibited until authentication and explicit consent exist.
4. **Secret detection is necessarily heuristic.** Explicit repository approval
   does not prove every eligible file is safe. The UI must continue showing the
   exact bounded preview before it is sent to local Ollama.

### Medium priority

1. `app/page.tsx` is 870 lines, `lib/knowledge.ts` is over 500, and the chat route
   coordinates chat, retrieval, artifacts, code context, and response headers.
   These are maintainability hotspots. Split by capability before adding more
   artifact types or routing modes.
2. The story-pack registry is an extension boundary, not a general automatic
   provenance system. Any new pack still needs reviewed source metadata and
   factual regression tests before registration.
3. Full dependency audit reports development-only transitive findings through
   the ESLint toolchain. Production audit is clean. ESLint 10 was tested and
   rejected because the current Next React plugin fails at runtime; upgrade when
   that supported combination exists.

### Repository maintenance

- Public `main` is current through merged PR #63 and its Linux and Windows CI passed.
- Release `v0.1.0` remains behind `main`; publish a new release only after the
  reliability week finishes and the release candidate passes.
- Automatic merged-branch deletion is enabled. Ten remote branches proven merged
  into `main` were removed on 2026-08-02; unmerged branches were preserved.
- GitHub issues #23 and #25 were closed because their synthetic retrieval
  evaluation and repository allowlist/search contracts are implemented.
- The GitHub homepage field is empty. Add a project/demo URL only when one exists;
  do not add a placeholder.

## Deliberately retained

- The 4 GB vault budget and evaluation rubrics are product policy/configuration,
  not accidental magic numbers. Both remain explicit and testable.
