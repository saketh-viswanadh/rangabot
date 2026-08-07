# Changelog

All notable Rangabot changes are documented here using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles. This file
records the complete product journey; `DAILY_PROGRESS.md` contains implementation
notes and `ROADMAP.md` separates approved, proposed, and decision-dependent work.

## Unreleased

### Improved

- Corrected the first fresh-chat visual iteration after production-size review.
  The empty state now has three deliberate layers—one compact personalized
  greeting, one content card with a single category selector, and four concise
  starters—instead of seven competing control bands. The resting composer is a
  one-row, 660 px welcome surface while active conversations retain the wider
  reading measure.
- Rebuilt sand, sage, and lavender as structural palettes across the canvas,
  sidebar, welcome card, composer, controls, and starter tints. Deterministic
  tests now cover text contrast in all six light/dark combinations and require
  meaningful perceptual separation between palette surfaces. Light-theme
  Markdown, status text, and accent-button foregrounds no longer rely on
  dark-theme-only hard-coded colors.
- Tightened responsive and accessibility behavior: primary mobile welcome and
  composer controls meet a 44 px target, the composer respects device safe
  areas, the mobile drawer prevents background focus and can scroll as its
  contents grow, and the non-modal Tools disclosure no longer claims modal
  dialog semantics.
- Reworked the fresh-chat experience around explicit, local-only preferences.
  People can optionally save a sanitized name or nickname for rotating greetings
  and choose Mix, Quotes, Jokes, Thoughts, or My books. These settings remain in
  browser-local storage and are never inserted into chat history, Local memory,
  the Knowledge Vault, or a model prompt.
- Added a local cited-book welcome path that samples bounded windows from the
  existing Knowledge Vault index, rejects unsuitable or executable-looking
  sentences, and retains only opaque recent-item identifiers in the browser.
  The first implementation exposed a roughly 30-second regression on a populated
  vault because it could scan large text blobs. The root fix added the
  `(document_id, ordinal)` chunk index and bounded ordinal/row-id lookups. On the
  inspected local vault, later requests reported roughly 40–90 ms of server
  application time and one rendered interaction completed in 299 ms. These are
  local diagnostic observations, not a cross-machine performance benchmark.
- Simplified the chat chrome into Brief plus a compact Tools menu for Memory,
  Analyze, Mastery, approved folders, and appearance controls. Small screens now
  receive an actual chat/project drawer with Escape handling and focus return.
  Sand, sage, and lavender light/dark palettes use clearer semantic contrast,
  while decorative butterflies and the multicolour thinking border were removed
  in favor of restrained motion.
- Removed the non-functional decorative banner from Path to Mastery so honest
  readiness, the main node, and capability branches appear earlier. Mastery
  detail dialogs now receive initial focus, trap keyboard focus, close with
  Escape or backdrop selection, restore focus, and lock background scrolling.
- Refreshed the public-safe product captures. Their maintained demo mode now
  refuses to load local conversations, projects, folder approvals, Knowledge
  Brief data, or a saved welcome name, preventing private UI state from entering
  repository screenshots.

- Replaced Analytics' failed free-form result narrator with a model-independent,
  typed narration contract. A diagnostic run on unchanged theatre v5 accepted
  0/11 model drafts: all 11 contained unsupported language, five invented
  limitations, and six introduced unsupported numbers. The new path retains the
  validated semantic plan, binds exact result cells and operation-defined units,
  renders through trusted code, and performs no second model call.
- Closed the issues found by two independent hostile reviews before merge.
  Analytics now renders every verified filter or explicitly discloses a display
  bound; separates base, denominator and numerator scopes; enforces exact output
  aliases, cardinality and row shape; bounds rows, columns, filters and long
  cells visibly; disambiguates qualified headers; expresses period bounds as
  half-open; and neutralizes Markdown images, links, code and email autolinks
  from local data. A real ReactMarkdown render test confirms hostile cell content
  creates neither an anchor nor an image.
- Bound every grounding and final SQL receipt to the preflight dataset identity
  and exact compiled-query hash inside the pack. Read-only and external-access
  flags are copied only after validation. Abort is rechecked after every awaited
  boundary, so a dependency that returns after Stop cannot turn cancellation
  into success.
- Added frozen zero-model-call narration evaluation: 44/44 independent canonical
  expectations pass and 222/222 forged narrations or invalid output shapes are
  rejected. The complete deterministic project suite is 270/270. These results
  prove bounded renderer integrity, not broad analytical planning, statistical
  interpretation, cross-model planning quality or blind human usefulness.
- On clean implementation commit `45d3ff1`, unchanged astronomy v4 and theatre
  v5 regressions each pass 12/12 with zero evaluator errors and 11/11 valid
  trusted narrations. Theatre v5 mean/median/P95 latency fell from
  5,014.8/5,023.5/8,018 ms on the preserved free-form baseline to
  210.1/221/237 ms, with no second narration model call. This is regression and
  latency evidence, not a new independent transfer result.
- Repaired the two remaining Analytics semantic failures without adding domain,
  question, value or model-specific production rules. Distinct populations now
  choose their qualifying relation only after local categorical grounding, using
  exact relation mentions, join proximity and deterministic tie clarification.
  Simple whole-population percentages resolve one unique local categorical
  condition before model planning; negated, qualified, absent or ambiguous
  conditions still fail closed. Denominator scope now also constrains the
  numerator when a future supported rate includes denominator filters. A removed
  denominator now forces clarification instead of silently widening the
  population; mixed Boolean polarity and zero-evidence distinct sources also
  clarify, while explicit Boolean rates and verified negative scopes execute.
- Froze the structurally isomorphic theatre transfer suite v5 in commit
  `f877d77` before the production fix, preflighted all 11 reference queries
  without a model, then recorded its first clean run on commit `23f5e2c`. It
  passed 12/12 with all 12 pack audits, all 11
  executed-result comparisons and zero evaluator errors; mean/median/P95 latency
  was 4.8/5.2/6.7 seconds. Astronomy v4 also reached 12/12 when rerun strictly as
  regression evidence. All 11 executed v5 answers still used the visible verified
  fallback, so narration, critical repetitions, cross-model evidence, human
  usefulness and broad generalization remain unqualified. The deterministic
  suite is now 262/262.
- After the hostile boundary audit, clean production commit `d0077fd` retained
  12/12 on both astronomy v4 and theatre v5 as regression checks, with 12/12
  pack audits, 11/11 executed-result comparisons and zero evaluator errors in
  each. V5 mean/median/P95 latency was 5.3/5.7/7.5 seconds. These reruns are
  regression evidence only; all 11 generated narrations in each were rejected.

### Architectural decisions

- Advanced the experimental Analytics reference to `0.2.0`. Models may still
  resolve a typed plan when deterministic semantics are insufficient, but no
  model—regardless of size—is trusted to author calculated facts, units,
  limitations or execution provenance. Future richer interpretation may select
  from existing fact IDs only and requires a separate frozen qualification gate.
- Advanced the Expert Pack Contract to v1.3 and added Analytics `0.1.0` as the
  first experimental runtime reference. Mind & Memory—not the pack—verifies the
  saved conversation's exact dataset attachment, constructs bounded canonical
  history, and issues resource-scoped dataset and request-scoped runtime grants.
  Strict request/result validators reject identity drift, forged grants,
  undeclared tools, widened permissions, mismatched execution resources,
  malformed model receipts and invalid terminal states. Success now requires
  evidence, model-background claims require a model receipt, and typed warnings
  distinguish grounded narration from verified fallback.
- Routed Analytics identity, schema, categorical grounding and final execution
  through one injected read-only DuckDB boundary with input-hash pinning and
  AbortSignal propagation. The provider now receives the resolved local model id
  explicitly; custom switching remains disabled unless it is already the
  configured model. Provider, timeout, cancellation and tool failures produce
  stable pack results and HTTP recovery semantics without silent retry.
- Isolated DuckDB in a killable local child process. The absolute SQL deadline
  now covers hashing, import, preparation and execution, so Stop and timeout do
  not depend on a native interrupt promise settling. In-flight cancellation and
  timeout tests exercise a query only after execution begins.
- Preserved the previous deterministic analytical intent gate and route order in
  the initial `0.1.0` adapter. That historical version used the numeric narration
  audit and verified-table fallback; `0.2.0` supersedes only its answer-rendering
  authority while retaining pack/version/model provenance. Synthetic dispatch tests lock deterministic answer, approved
  memory, code-allowlist and Analytics precedence. The HTTP and client seams
  validate traces, and mismatched evidence/trace provenance fails closed.
  Analytics remains experimental: the separately frozen isomorphic v5 check
  scored 12/12, while broad transfer, narration and the remaining pack-level
  qualification gates remain open. No model download, pack installation manager,
  Python runtime or other pack was enabled.
- Added an optional Expert Pack mode to the sealed astronomy evaluator without
  changing its cases, expected semantic plans, gold SQL or legacy default. A
  final audit found that runner 2.0's result matcher ignored cell positions and
  row multiplicity and that narration grounding checked numbers only. Runner
  2.1.2 replaces those defective implementations with typed positional cells,
  one-to-one multiset rows, explicit outer ordering, truncation rejection,
  bounded row/label binding, qualitative/ranking/causal checks and a documented
  two-decimal tolerance. The previous runner-2.0 result is superseded rather than
  treated as directly comparable.
- Runner 2.1.2
  records source/pack/model/context/Ollama/hardware/cold-warm provenance and
  scores user-visible narration, evidence, permissions, grants, tools, model
  receipts and terminal results. The clean warm run at commit `8725d47` scored
  10/12 (83.3%; 5.3-second mean, 4.5-second median, 18.1-second P95) with all 12
  pack audits, all 10 executed-result comparisons and zero evaluator errors.
  Every generated query narration failed the stricter audit, so all 10 query
  answers used the direct verified fallback. Targeted tests do not replace this
  complete sealed result or the still-missing human/cross-model gates.
- Persisted a generic `verified-fallback` answer disposition and show it beside
  the answer with a crafted shield notice. Unknown or malformed warning headers
  fail closed, and imported conversations now reuse the full bounded message
  validator instead of accepting arbitrary metadata.
- Approved an installable Expert Pack direction for Rangabot's post-reliability
  architecture. Mind & Memory remains the single privacy, precedence,
  conversation and permission control plane; Analytics, Scholar, Documents,
  Builder and later Research packs contribute bounded tools, context and typed
  evidence without becoming separate chat personalities.
- Defined a pack as a capability contract—not merely a prompt or bundled model.
  Each pack must declare its tools, permissions, resource requirements,
  supported operations, quality suite, evidence format and limitations. Planned
  capability is not represented as shipped until its frozen acceptance gates
  pass.
- Approved per-pack model assignment with three user choices: automatically
  select a qualified installed model, reuse the general conversation model, or
  explicitly select another installed model. Compatibility and recommendation
  are pack-specific; untested combinations remain available only with a visible
  experimental label.
- Approved resource-aware sequential execution. Model files may coexist on
  disk, but Rangabot should load only the model required for the active stage,
  prefer reuse when quality is sufficient, unload inactive large models on
  memory-constrained machines and disclose model switches before execution.
- Rejected compulsory one-model-per-skill routing. Deterministic runtimes,
  validation and rendering remain the primary reliability mechanisms; specialist
  models are optional engines whose benefit must be demonstrated by the pack's
  unchanged qualification suite.

- Added a registry-driven cross-model conversation matrix that evaluates one
  installed Ollama model at a time, fixes its context budget, unloads it before
  the next profile and preserves full answers only in private ignored results.
  Critical-only is the safe default; selected diagnostics and complete-suite
  runs are labelled separately so partial evidence cannot become a release
  score.
- Standardized `OLLAMA_NUM_CTX` across text, JSON and streaming generation.
  Memory-fit guidance remains enforced by default, and an undersized-machine
  override must be explicit. `qwen2.5:7b` remains an opt-in registry profile
  rather than replacing the 3B starter model.
- Replaced the earlier automatic timeout retry with one absolute generation
  deadline. A Qwen cold diagnostic demonstrated that two per-attempt deadlines
  could keep one request open for 328 seconds. Cancellation, timeout, unavailable
  runtime, missing model, HTTP failure, empty output, malformed stream and
  partial-stream behavior now have deterministic provider simulations and typed
  API failures. Rangabot never silently starts a second generation attempt.
- Compared Llama 3.2 3B and Qwen2.5 7B on the unchanged 22-case critical suite.
  Both recorded 21/22. Qwen averaged 11.1 seconds versus Llama's 4.8 seconds;
  Qwen's scored failure was an evaluator wording false negative, while Llama's
  failure materially repeated a false claim about Python indentation. The
  frozen scores remain unchanged. Qwen remains available as an opt-in registry
  profile for suitable hardware, not a default or automatic route. Its local
  4.7 GB artifact was removed after evaluation because the narrow reasoning
  benefit did not justify its memory pressure, latency and Teacher Mode failures
  on the tested 8 GB Mac.
- Qwen failed the unchanged adaptive-reviewer qualification at 1/12, matching
  the blocked Llama result. It must not review or rewrite live answers.
- Added explicit model/context selection to Knowledge answer evaluation and
  included both values in its checkpoint key and private result metadata. This
  prevents a Qwen comparison from silently resuming Llama-generated answers.
  A first three-case Qwen diagnostic completed 1/3 within the 180-second case
  deadline; two timeouts make it unsuitable for routine Teacher Mode on the
  tested 8 GB profile.

- Added a deterministic semantic-role resolver ahead of advanced model plans.
  It independently identifies high-confidence count populations, grouping
  grains, numeric measures, row-count denominators, relation thresholds,
  unmatched relations, period grains and duration endpoints from the current
  request and approved schema, then overrides model fields only when evidence is unique.
  Missing or ambiguous average-of-totals roles now clarify instead of executing
  an unrelated metric.
- Added a reusable development-only clinical suite with semantic-plan and result
  checks. After an expanded 7/9 run and two provider-timeout runs exposed the
  remaining model dependency, fully resolved plans and obvious “best”
  ambiguities now bypass model planning. The final development run passed 9/9
  in 196 ms total, but this is tuning evidence—not an unseen transfer score—and
  does not change the strict 3/13 release evidence.
- Froze and ran a new 12-case astronomy transfer suite after 196/196 tests and
  all release checks passed. The first result is 10/12 (83.3%) in 27.7 seconds:
  ten cases matched both semantic expectations and reference results. One
  distinct-count query was mathematically correct but failed the frozen exact
  source-field rubric, and the model-dependent conditional-rate case returned
  malformed output. The suite is sealed and the 90% transfer target is not met.

- Extended the model-independent analytical grammar with distinct populations
  and nested group aggregation, then centralized local categorical-value
  grounding. Every Ollama model now proposes the same schema-derived semantic
  plan; trusted code ignores unused model fields, validates relationships and
  compiles the SQL without accepting model-authored execution logic.
- Added an explicit analytical semantic contract plus cross-domain tests that
  prohibit fixture tables, values and expected answers from production code.
  The full deterministic suite passes 185/185.
- Froze an unseen 13-case ecology transfer suite. Its original result-only
  scorer reported 6/13, but strict query review found three coincidental scalar
  matches produced with the wrong operation or grain. The defensible score is
  therefore 3/13. Future holdouts require an expected semantic-plan match as
  well as the correct executed result; no broad analytical reliability claim is
  made.

- Dataset approval and chat attachment are now separate, explicit states:
  approval remains in the private local allowlist, while a conversation stores
  and restores its selected dataset until the user removes it. Reopening a chat
  no longer silently discards its analytical context.
- Expanded model-independent analytical routing for attached-data exploration
  such as “tell me about this data” and “what do you notice,” while unrelated
  comparisons such as Python versus SQL remain ordinary conversation.

- Replaced an unpublished benchmark-shaped analytical prototype with a
  domain-neutral operation grammar for ratios, conditional rates, durations,
  grouped thresholds, period growth, per-entity averages and anti-joins. Its
  schema, fields and join graph are derived from the approved dataset; production
  planners contain none of the commerce benchmark table names.
- Added a frozen 12-case logistics transfer holdout. Its first and only v1 run
  passed 5/12, so the earlier prototype's 26/50 result is withdrawn as evidence
  of general capability and analytical planning remains experimental.
- Added a current-request provenance audit for advanced model plans. It removes
  unsupported filters and dimensions, validates types and operation contracts,
  derives only unambiguous calendar/source corrections, and asks instead of
  guessing. A fresh library holdout produced 6 valid passes out of 10 valid
  cases; two broken reference queries invalidated the other cases. Holdout
  preflight now executes all references before the first model call.
- Fixed the numeric-grounding tokenizer: JSON cell separators could previously
  join adjacent values such as `2` and `28.03` into `228.03`. Prior full-suite
  baselines contained no cases with correct SQL rejected solely by this defect,
  so the published 3/50 and 12/50 comparisons remain valid without rescoring.

- Replaced live free-form conversational SQL generation with a typed analytical
  plan and deterministic compiler for simple aggregates. The model can select
  only grammar-approved tables, fields, operators and actions; trusted code
  validates scope, removes unrequested filters, resolves safe join paths,
  compiles quoted SQL, and handles common date/status semantics. On the unchanged
  50-case suite, `llama3.2:3b` improved from 3/50 to 12/50, including 9/10 easy.
  Medium, hard and extreme planning remain experimental and below gate.

- Added read-only multi-table DuckDB approval, schema inspection, relevant-table
  focusing with inferred join bridges, typed query/clarify/unavailable planning,
  and a frozen 50-case conversational SQL benchmark. The first strict
  `llama3.2:3b` baseline passed only 3/50, so multi-table autonomous planning is
  explicitly experimental and remains blocked from a reliability claim.
- Fixed Ollama 0.32.4 structured-output compatibility by keeping unsupported
  string-length keywords out of the provider JSON grammar while enforcing the
  same limits in the trusted parser. Complete results can no longer be described
  as truncated by an accepted generated narration.

- Added a model-independent Local memory selection audit and corrected domain
  scoping, related-topic matching, current-choice conflicts, and newest-wins
  supersession. The frozen 24-scenario audit improved from 73.3% precision and
  73.3% recall to 100% (15/15) for both measures. The unchanged 60-case model
  suite retained 15/15 across memory use, privacy, and precedence.

- Rangabot now treats approved datasets as conversational evidence. Analytical
  requests automatically run validated, bounded read-only SQL locally; answers
  are numerically audited against the actual result and include an expandable
  calculation trace. Ordinary conversation does not read the dataset.

- Approved datasets can now be explicitly attached to chat. Rangabot sends only
  their schema to local Ollama, validates the returned read-only `SELECT`, and
  opens the draft in the SQL review workspace. Query review and **Run once**
  remain separate required actions; the model cannot approve execution.

- Fixed a macOS development-server crash where the desktop session's file
  watcher limit caused repeated `EMFILE` errors and false 404 responses. The
  launcher now uses bounded polling on macOS while preserving native watching
  on Linux and Windows.

- Added a private SQL workspace where users approve CSV or Parquet files, inspect
  the exact read-only query and limits, explicitly choose **Run once** or
  **Reject**, and review bounded results with a verifiable execution receipt.
  Ordinary chat messages and model output still cannot trigger execution.

### Evaluation

- A conservative verified-reasoning ledger now computes recognized speedup and
  equal-majority class-baseline facts locally, injects them into the shared
  answer contract, and preserves essential facts if model repair omits them.
  The complete v1.0.11 candidate improved from 56/60 to 59/60, reasoning from
  3/5 to 5/5, and mean latency from 6.7s to 5.9s while retaining 22/22 critical.

- Leading-premise verification and a deterministic minimum causal invariant now
  prevent local models from silently accepting false premises or omitting the
  shared-variable explanation after a failed repair. The complete candidate is
  56/60, 22/22 critical, and 6.7 seconds mean latency after a documented v1.0.11
  rescore; reasoning remains release-blocked at 3/5.

- Core evaluator v1.0.9 repairs three semantic false negatives without changing
  production behavior or gates. Three complete critical repetitions rescore to
  20/22, 22/22, and 22/22; the first run retains two genuine reasoning failures,
  so Rangabot remains release-blocked.

### Added

- Local dataset approvals and a five-minute, single-use SQL confirmation bind
  execution to the exact previewed dataset fingerprint and query. Replay,
  altered queries, changed files, expired tokens, and revoked approvals fail
  closed. Chat-triggered execution remains locked pending the visible UI.

- A backend-only safe DuckDB foundation can execute one bounded read-only query
  over an explicitly approved CSV or Parquet file in a fresh in-memory database.
  It disables external access before query execution and returns a local receipt;
  chat-triggered execution remains locked pending an approval-preview flow.

- A frozen reviewer-qualification gate now prevents an unproven local critic
  from rewriting production answers. It uses schema-constrained Ollama output,
  six bad-draft corrections, six good-draft preservation cases, and requires
  12/12 before activation. `llama3.2:3b` scored 1/12, so adaptive review remains
  deliberately locked instead of making Rangabot slower and less reliable.
- Answer normalization now removes leaked role labels, preserves line breaks
  while enforcing word limits, and keeps inline numbered lists structurally
  valid after truncation.
- Semantic repair is now monotonic: a candidate must remove a detected contract
  issue without collapsing substantive content, or Rangabot keeps the original.
  The complete preserved candidate rescored under v1.0.8 is 57/60 overall,
  22/22 critical, with every category at 4/5 or better; release remains
  conditional pending repeated critical and human gates.

- Mind & Memory now has a documented model-independent control plane: typed
  answer contracts, one shared precedence assembler across ordinary and Scholar
  chat, conflict-aware memory selection, deterministic unavailable-action
  boundaries, narrow format conformance, and selective semantic self-repair.
- The Ollama boundary now propagates user cancellation, classifies timeout,
  unavailable runtime, missing model, HTTP, empty-output, and malformed-stream
  failures, and retries only a safe timeout—never a cancelled request.
- Core evaluation v1.0.6 preserves a balanced 60-case suite, records transparent
  rubric repairs, supports critical-only variance runs, and keeps full answers
  private. The current 3B-model candidate remains release-blocked at 52/60 and
  21/22 critical cases; architecture work is not presented as mastery.

- Path to Mastery now leads with strict capability readiness: 8/45 fully
  unlocked, or 18%. Criterion verification (37%) and weighted development
  progress (46%, including half-credit for partial work) are separately labelled
  secondary measures so unfinished work cannot be mistaken for readiness.

- Path to Mastery v2 now audits 9 program epics, 45 capabilities, and 146
  criterion assessments with calculated scores/states and a canonical registry
  of 41 merged PRs used as evidence. It adds the omitted Platform & Release epic
  and displays criterion notes and evidence links in the app and public chart.
- Founder recognition was re-audited into 29 attributable node claims.
  Contribution credit is explicitly independent from product readiness and
  cannot be attached to a wholly planned capability.

- A privacy-safe public product showcase now presents the current conversation
  workspace, local Knowledge Brief, and Path to Mastery beneath the repository
  banner instead of using brand art as the only visual evidence of Rangabot.

- Frozen Core Conversation Contract v1 and a balanced 60-case synthetic suite
  replace the earlier 20-case exploratory check. Results now record suite,
  commit, model, Ollama, context, hardware, run-state, completion, critical-trust,
  per-capability, latency, and error provenance. A public evaluator changelog
  records every rubric repair and its effect on comparability.

- Centralized runtime product identity, registry-derived default models, stricter
  unused-code checks, runtime-only filesystem tracing, and generated Next type
  handling reduce duplicated configuration and build noise.
- Repository maintenance now automatically deletes future merged branches; ten
  already-merged remote branches and two completed issues were reconciled.
- A model-independent conversation orchestration layer now gives every local
  model the same directness, truthfulness, recency, correction, hard-constraint,
  and memory-precedence contract before ordinary chat generation.
- A private synthetic Mind & Memory stress suite measures instruction following,
  continuity, reasoning, honest capability boundaries, adaptation, memory use,
  memory privacy, and latency without reading real conversations or memories.
- A chat-focused sidebar keeps projects, search, transfers, and conversation
  history together while moving Brief, Memory, Mastery, local folders, and the
  privacy indicator into a compact responsive header utility rail.
- A title-first conversation focus stack expands the hovered chat, reveals its
  actions on demand, and gently recedes neighboring titles; All chats and folder
  marks now use lighter layered linework.
- Inspectable local memory for explicitly approved preferences, facts, and
  standing instructions, with visible provenance, edit/delete controls, JSON
  export, and bounded context injection into ordinary and Teacher Mode chats.
- Deterministic direct-memory recall for identity and memory-list questions so
  small local models cannot ignore a saved fact or improvise an answer.
- Persistent per-answer memory receipts distinguish ordinary approved-context
  use from deterministic direct recall in both live and reopened conversations.
- Review-first Local memory JSON import with strict provenance and size checks,
  duplicate skipping, conservative conflict detection, and explicit per-conflict
  replacement approval.
- Relevance-aware Local memory selection prevents unrelated approved facts from
  entering a model request and discloses only safe memory titles on each answer.
- Governed, evidence-backed mastery attribution with CODEOWNER protection, a
  public claim workflow, local-only optional portraits, node-level contributor
  credits, and founder recognition covering 19 verified capabilities.
- A shared Japanese-craft-inspired SVG icon language across navigation, chat,
  creation tools, local privacy controls, Knowledge Brief and Path to Mastery,
  replacing platform-dependent Unicode symbols with restrained local geometry.
- **Path to Mastery**, an interactive Assassin-inspired capability tree whose
  main paths, subskills, strict scores, dependencies, acceptance criteria and
  next tasks also form Rangabot's public contributor backlog.
- A canonical mastery JSON model and generated Markdown view, including an
  approved persistent web-allowlist node that must unlock before web research.
- A spacious, scrollable mastery layout with Rangabot banner art, hover and
  keyboard unlock previews, complete public checklists, and an opt-in local
  contributor achievement wall that never fetches GitHub avatars at runtime.
- Conversation-aware local retrieval planning for context-dependent follow-up
  questions, using the latest substantive user topic without changing the
  question Rangabot answers.
- Per-answer retrieval diagnostics distinguish full hybrid search from the safe
  keyword-only fallback in the chat source label and persisted history.
- A registered story-pack interface replaces route-level Ramayana branching and
  provides one bounded extension point for future provenance-aware collections.
- A contradiction regression rejects answers that collapse data leakage and
  concept drift into the same concept.
- A severity-ranked full-tree code, privacy, dependency, documentation, and
  public-GitHub review with explicit unresolved risks.
- Shared bounded chat validation and local-runtime configuration tests.
- Conversational Word creation inside ordinary chat. Rangabot gathers missing
  requirements, uses the local model to draft finished content, applies
  deterministic DOCX formatting, stores artifacts privately, renders previews,
  and presents an in-chat download link.
- Genre-aware Word output for reports, proposals, meeting notes, technical
  briefs, guides, articles, and children's story collections.
- Conversation-to-Word summaries that incorporate both user questions and
  Rangabot's substantive answers rather than reproducing requirement prompts.
- A shared artifact-quality foundation for future PDF, email, long-form writing,
  technical-documentation, presentation, and spreadsheet abilities.
- An explicit local repository allowlist with canonical-path validation,
  revocation, scoped text search, bounded line-numbered previews, and visible
  code-context attachment to local-model requests.
- Local conversation search, persistent pinning, Markdown export, and restore.
- A dedicated Knowledge Brief experience with weekly intelligence cards,
  monthly archives, vault status, and meaningful subject updates.
- A 300-item offline welcome library containing 100 quotes, 100 jokes, and 100
  thoughts, with a browser-local 60-item no-repeat window.
- Source-state reporting for indexed, pending, and incompatible Knowledge Vault
  files, including visible filenames and reasons requiring attention.
- Portable content-hash vault synchronization so indexed books survive a local
  project-folder or repository rename without duplicate passages.
- Versioned hierarchical ingestion preserving section paths, headings, and PDF
  page ranges on passages, with automatic in-place SQLite migration.
- The approved Rangabot Learning Core roadmap: hierarchical book understanding,
  conversation-aware planning, multi-book synthesis, inspectable local memory,
  grounding review, cross-book concept summaries, and feedback-based evaluation.
- A compact native `sqlite-vec` index for existing local embeddings, including
  an explicit `knowledge:vector-index` rebuild command.
- A privacy-preserving local retrieval evaluation harness with reusable starter
  cases, private vault-specific fixtures, timestamped reports, and measurable
  relevance, contamination, diversity, locator, and latency results.
- A balanced 60-question benchmark spanning ten subject groups and three
  difficulty levels, with answer-level concept, grounding, forbidden-claim,
  cited-source synthesis, revision, and latency scoring.
- Resumable answer evaluation with per-case atomic checkpoints, a five-minute
  evaluation timeout, isolated error reporting, and automatic retry of only
  unfinished cases.
- A Teacher Mode grounding gate that audits citation coverage, citation numbers,
  and lexical support before returning an answer, revises weak drafts once
  locally, and warns visibly when the revision remains insufficiently grounded.

### Changed

- Removed unused mascot GIF/sprite-atlas and stale screenshot payloads while
  retaining the PNG and CSS motion used by the live interface.
- Deferred the Memory panel and 301 KB Markdown/highlighting implementation until
  first use, reducing the main application-specific client chunk from roughly
  362 KB to 57 KB in the audited production build.
- Updated React type definitions to current compatible patch releases.

- Knowledge Doctor now streams large-file hashing, reports when its deep scan
  starts, and returns a clear incomplete-check warning after a bounded timeout.
- Ollama chat and embedding configuration is now centrally validated as
  loopback-only, with the documented lightweight model as the single fallback.
- The 2026-08-02 assumption that one automatic timeout retry was safe has been
  withdrawn. A timeout cannot prove that local generation never began, so retry
  now requires a new explicit request rather than hidden duplicate work.
- Answer evaluations exclude execution errors from completed-case quality and
  latency averages and report a separate conservative overall pass floor.
- Repository previews now reject high-confidence secret content in addition to
  common sensitive filenames; document preview rendering no longer overrides
  the subprocess home directory.
- Updated `pdfjs-dist` to 6.2.108 and added defensive response headers.
- Teacher Mode now maps each requested answer part to the strongest matching
  passages before drafting. When a first draft fails the unchanged grounding
  gate, Rangabot tries fast deterministic evidence/background separation before
  spending time on a second local-model generation; revision remains available
  only when that safe local transformation is insufficient.
- Smart Mode and Teacher Mode now treat retrieval as evidence gathering rather
  than the final response. Vault evidence is combined with relevant conversation
  context and clearly distinguished background from the downloaded local model.
- Teacher Mode is citation-first rather than passage-only: it may teach beyond an
  incomplete vault using labelled local-model background while preserving gaps,
  uncertainty, historical interpretations, and mythology variants.
- Knowledge retrieval now cleans conversational filler, weights source titles,
  combines keyword and semantic relevance, reranks results, removes duplicates,
  and applies a relevance floor before evidence reaches the model.
- Relevant evidence is diversified across matching books before prompt assembly;
  weak sources remain excluded and source diversity is never forced through the
  relevance threshold.
- Subject-aware retrieval excludes books with a clearly conflicting title-level
  domain while retaining relevant and uncategorized sources for normal reranking.
- Subject recognition now covers implicit SQL/statistics questions and compact
  or domain-specific source titles, raising the 60-question retrieval pass rate
  from 85% to 90% while eliminating measured cross-subject contamination.
- Semantic candidates are searched in native SQLite vector storage instead of
  parsing and comparing every JSON embedding in JavaScript. The index rebuilds
  automatically when stale and retains the prior portable search as a fallback.
- Teacher Mode buffers its answer until the local grounding review finishes;
  ordinary and Smart modes retain token streaming.
- Teacher Mode now normalizes small-model `[N]` citations, keeps nested content
  inside an explicit Local model background boundary, ignores adjacent but
  unhelpful passages, and answers the actual question before adding detail.
- Teacher Mode now receives an explicit subtopic and claim-to-source plan before
  drafting, retains the better-grounded version when revision regresses, joins
  isolated citation markers to their claims, and conservatively recovers missing
  citations only when one passage has strong lexical support.
- Answers that remain mixed after revision are deterministically separated into
  vault-grounded evidence and clearly disclosed local-model background instead
  of returning an undifferentiated warning-laden draft.
- Knowledge answers can use five bounded, reranked passages instead of three
  shorter raw matches, improving cross-source context without flooding small
  local models.
- Compatible Knowledge Vault files continue ingesting successfully even when
  separate incompatible sources are skipped and reported.
- Ranga's visual treatment was refined into a restrained golden-retriever
  silhouette with pastel theme-aware colouring, subtle cursor attention, sparse
  ambient particles, and a calmer thinking-light treatment.
- The repository and product identity were unified under the Rangabot name.

### Fixed

- Streaming answers no longer force the reader to the bottom after they scroll
  upward, while near-bottom readers still follow new tokens automatically.
- Chat history now persists locally through SQLite and loads safely in Next.js
  development.
- The pin control remains discoverable without requiring a precise hover state.
- Knowledge retrieval no longer mixes unrelated Python, mythology, history, or
  data-science passages merely because filler words overlap.
- Stale pre-rename database paths are relinked by content hash instead of leaving
  books apparently indexed but inaccessible.
- Empty HTML, image-only PDFs, and page-marker-only extractions are rejected
  instead of being advertised as searchable knowledge. `knowledge:doctor`
  reports unindexed, moved, stale, incompatible, and textless sources.
- `knowledge:doctor` distinguishes known incompatible sources from genuinely
  pending files, so skipped files no longer trigger a false re-ingestion action.
- Word creation no longer turns creative requests into generic business reports
  containing purpose, audience, raw chat answers, or planning scaffolding.
- Children's story collections require complete reader-facing stories and use a
  dedicated layout rather than a report template.
- Malformed local-model schema fragments such as `sections`, `heading`, or
  `bullets` are rejected instead of leaking into generated Word documents.
- Markdown markers and duplicated bullet symbols are normalized before DOCX
  rendering.
- Privacy validation no longer removes a running Next.js server's build output.

### Security and privacy

- Vault sources, indexes, chats, memories, generated artifacts, and repository
  approvals remain local and Git-ignored.
- Repository context is read only from explicitly approved folders and is sent
  only to local Ollama.
- Cloud/Codex handoff remains disabled until a separate preview and visible user
  approval flow is designed and approved.
- Continuous learning will be inspectable, editable, deletable, provenance-aware,
  and reversible. Conversations will never modify model weights automatically.

### Planned next

1. Plan questions using the conversation, then retrieve and compare relevant
   material across multiple books and conversation
   history.
2. Synthesize original explanations from vault evidence, local-model knowledge,
   and user context rather than returning retrieved text.
3. Add reviewable local memory for preferences, proficiency, progress,
   corrections, and user-approved conclusions.
4. Add draft, grounding, completeness, and revision passes plus a permanent local
   evaluation suite that proves whether Rangabot is improving.

## 0.1.0 - 2026-07-28

### Added

- A Next.js 16, React 19, and TypeScript application hosted locally on
  `127.0.0.1`.
- A typed Ollama provider abstraction, local status and chat endpoints, streaming
  responses, and Stop generation.
- Local-only, Smart routing, and Teacher Mode controls with visible privacy and
  Knowledge Vault indicators. Cloud/Codex mode remained safely disabled.
- Responsive Apple-inspired chat UI with pastel light and dark themes, Markdown,
  syntax-highlighted code, copy controls, message replies, loading states, and
  the animated Ranga mascot.
- Local SQLite conversation creation, listing, reopening, updating, and deletion.
- Local project folders for organizing project-scoped chat history.
- A private 4 GB Knowledge Vault with incremental PDF, DOCX, HTML, Markdown, and
  text ingestion, hybrid keyword/embedding retrieval, citations, backups,
  validation, rollback, and self-service maintenance commands.
- Automatic Smart-mode vault lookup and Teacher Mode capability/catalog answers.
- Initial offline data-science material for NumPy, pandas, scikit-learn, and
  DuckDB, plus sourced weekly and monthly subject-intelligence briefs.
- Open-source governance, contribution, security, support, architecture, privacy,
  model-selection, source-licensing, and community-launch documentation.
- A public local-model registry with hardware and upstream-license guidance.
- Linux and Windows CI, macOS clean-clone rehearsal, secret scanning, privacy
  checks, and protected pull-request development.
- Apache-2.0 licensing for code and documentation, CC BY 4.0 licensing for
  original Ranga artwork, provenance records, and a distinct-product naming
  policy for modified distributions.
- A synthetic public demo and privacy-safe screenshots.

### Fixed

- Initial chat overflow and scrolling problems.
- SQLite loading failures during Next.js development.
- Repeated welcome content and overly active mascot animation.
- Small or hard-to-find Knowledge Brief and pinning controls.
- Source licensing and release-readiness gaps discovered during the open-source
  rehearsal.

[Unreleased]: https://github.com/saketh-viswanadh/rangabot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saketh-viswanadh/rangabot/releases/tag/v0.1.0
