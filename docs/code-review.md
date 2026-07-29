# Critical code and repository review

Last reviewed: 2026-07-29

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
2. Embedding failures fall back to keyword retrieval with limited diagnostics.
   The UI should distinguish hybrid, keyword-only, and degraded retrieval per
   answer instead of exposing only a general vault-used indicator.
3. The Ramayana document path has a hardcoded curated special case. It is an
   intentional safety fallback, but it is not a scalable artifact architecture.
   Replace it with a registered, provenance-aware story-pack interface.
4. Next.js reports a whole-project file-tracing warning through repository path
   handling. The build succeeds, but packaging boundaries should be narrowed.
5. The generated `next-env.d.ts` import flips between development and production
   paths. It is harmless but creates avoidable worktree noise.
6. Full dependency audit reports development-only transitive findings through
   the ESLint toolchain. Production audit is clean. ESLint 10 was tested and
   rejected because the current Next React plugin fails at runtime; upgrade when
   that supported combination exists.

### Repository maintenance

- Public `main` is current through PR #49 and its required CI passed.
- The adaptive-grounding and review work is still local and is not on GitHub.
- Release `v0.1.0` is 21 commits behind `main`; publish a new release only after
  the current quality/security work is merged and retested.
- The remote has 31 branches and automatic deletion after merge is disabled.
  Enable automatic merged-branch deletion and prune only confirmed merged
  branches; do not bulk-delete without review.
- The GitHub homepage field is empty. Add a project/demo URL only when one exists;
  do not add a placeholder.

## Deliberately retained

- The public Ranga GIFs and spritesheet are not used by the current CSS UI, but
  they are documented redistribution assets for compatible community UIs. Treat
  their removal as an artwork-package decision, not dead-code cleanup.
- The 4 GB vault budget and evaluation rubrics are product policy/configuration,
  not accidental magic numbers. Both remain explicit and testable.
