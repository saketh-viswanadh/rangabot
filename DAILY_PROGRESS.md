# Daily progress

## 2026-08-07 — Local fresh-chat personalization and strict UI audit

- Rebuilt the empty-chat welcome around rotating, content-driven greetings and
  an optional sanitized name or nickname. The preference is local to the browser
  and is not promoted into chat history, Local memory, the Knowledge Vault, or
  the model prompt.
- Added explicit Mix, Quotes, Jokes, Thoughts, and My books controls. The first
  four reuse the bundled offline welcome library; My books returns one
  self-contained cited sentence from the existing local index, shows a clear
  no-compatible-fact state, and keeps only opaque recent-item identifiers rather
  than the sentence text.
- Caught a serious performance regression during real browser testing: the first
  cited-book implementation could take about 30 seconds against the populated
  vault because it scanned large chunk content. Replaced that path with bounded
  document/ordinal windows backed by a `(document_id, ordinal)` index and a
  bounded row-id fallback for older read-only indexes. Observed server
  application time fell to roughly 40–90 ms, and one end-to-end rendered refresh
  completed in 299 ms on this local setup. These measurements are diagnostic,
  not a general latency guarantee.
- Consolidated secondary workbench controls under a compact Tools menu and gave
  mobile layouts a real chat/project drawer with visible dismissal, Escape
  handling, initial focus, and focus return. Brief and local-model status remain
  immediately visible.
- Rebalanced sand, sage, and lavender light/dark palettes with semantic surface,
  text, border, focus, and status colors. All three inspected light user-bubble
  combinations exceeded the 4.5:1 normal-text contrast target. Removed ambient
  butterflies and the rainbow thinking frame; one restrained activity accent
  remains.
- Removed Path to Mastery's decorative banner, bringing the honest readiness
  summary and capability tree above the fold. Detail dialogs now declare their
  description, receive and contain keyboard focus, close with Escape or backdrop
  selection, restore focus, and prevent background scrolling.
- Browser QA covered the fresh state, personalization, category switching, a
  cited local-book fact, desktop and 390 px mobile layouts, the mobile drawer,
  Tools, and Mastery dialog lifecycle. The focused knowledge-welcome suite passes
  7/7, including a 4,000-passage bounded-selection fixture. This does not prove
  all visual combinations or turn the welcome fact into a teaching benchmark.
- Added a public-safe welcome capture mode and refreshed the README home and
  Mastery images. Capture mode deliberately skips private conversations,
  projects, folder approvals, Knowledge Brief data, and saved welcome names.
  Short desktop windows no longer auto-scroll the empty chat to its bottom
  anchor, and the closed mobile drawer is removed from pointer and accessibility
  navigation until opened.

## 2026-08-07 — Trusted analytical narration and execution binding

- Captured the actual v5 failure baseline before changing production behavior.
  The unchanged pack attempted 11 free-form narrations and accepted none: 11
  unsupported-language, five false-limitation and six unsupported-number
  failures. The visible fallback kept answers safe but did not prove useful
  narration.
- Removed unrestricted result prose from Analytics `0.2.0`. The pack now keeps
  the basic/advanced plan typed through execution, derives exact output grain,
  aliases, cells, units and scope in trusted code, and structurally audits the
  canonical answer. A local model is still available for unresolved typed
  planning; it cannot author calculated facts or limitations.
- Red-teamed the first renderer draft before accepting it. Fixed silent
  fourth-filter loss, ambiguous conditional populations, silent cell shortening,
  unbounded columns, active Markdown/image/email injection, wrong-column units,
  generic-null wording, acronym/colliding headers, half-open period wording,
  implementation-enum leakage, unexpected aliases/cardinality and late-cancel
  races.
- Added pack-level receipt binding. Grounding and final executions must match the
  preflight input fingerprint and the exact compiled-query hash; unsafe or
  inconsistent receipts fail without evidence. Cancellation is terminal even if
  an injected dependency ignores Abort and returns.
- Froze 44 public-safe canonical narration cases covering all nine advanced
  operations and all five basic aggregates, plus scope, bounding, Unicode and
  Markdown safety. All 44 pass. The audit rejects 222/222 forged outputs and six
  invalid result shapes without a model call. ReactMarkdown rendering confirms a
  hostile local cell creates no link or image.
- The full deterministic suite passes 270/270. On clean implementation commit
  `45d3ff1`, astronomy v4 and theatre v5 each remain 12/12 with zero evaluator
  errors, 11/11 structurally valid trusted narrations and zero model-authored
  narration attempts. V5 mean/median/P95 latency is 210.1/221/237 ms, compared
  with 5,014.8/5,023.5/8,018 ms on the preserved free-form baseline at
  `b8a3938`—a 95.8% mean-latency reduction on the same frozen suite. These later
  runs are regression evidence, not new transfer qualification.
- Honest boundary: this improves exact presentation, provenance and latency. It
  does not prove broad planning transfer, causal/statistical interpretation,
  cross-model planning quality, critical repetitions or blind human usefulness.

## 2026-08-07 — Model-independent analytical semantic repair

- Froze the theatre v5 transfer definition at commit `f877d77` before changing
  production behavior. Its database and 11 reference queries passed preflight
  without invoking the model. The suite is a separately frozen isomorphic
  domain-and-name transfer check, not broad independent generalization evidence.
- Replaced distinct-count source guessing with a post-grounding resolver. It uses
  only operation-relevant fields, complete relation-name evidence and approved
  join distance; prefix-sharing distractors no longer tie with an exact relation,
  schema order cannot change the answer, and equal evidence becomes a focused
  clarification.
- Added deterministic whole-population percentage recovery. It requires an
  explicitly named population, safe unqualified denominator grammar and exactly
  one categorical value found in one field on that population relation. Negation,
  multiple values, cross-relation values and ambiguous fields remain non-
  executable. Fully resolved rates bypass model planning.
- Fixed conditional-rate algebra so denominator predicates also constrain the
  numerator. Added integration, metamorphic, ambiguity, local-value, provider-
  bypass and production hardcoding tests across unrelated schemas.
- A hostile follow-up audit found additional fail-open edges beyond the two
  frozen failures. Rangabot now clarifies when a denominator condition cannot be
  verified, when Boolean polarity is mixed, or when no evidence identifies an
  observation relation. Verified negative scopes, bare populations and explicit
  Boolean rates remain executable. Clarification plans retain only sanitized
  filters.
- Astronomy v4 moved from 10/12 to 12/12 as regression evidence. The first clean
  theatre v5 Expert Pack run at commit `23f5e2c` passed 12/12, all 12 pack audits,
  all 11 result comparisons and zero evaluator errors. Mean/median/P95 latency
  was 4.8/5.2/6.7 seconds on the recorded warm Llama 3.2 3B / Apple M1 profile.
- All 11 executed v5 narrations failed the strict evidence audit and used the
  visible verified fallback. The run met the manifest's 90% single-run overall-
  score threshold on this isomorphic check, but broad transfer, narration,
  required repetitions, cross-model behavior and human usefulness remain open;
  Analytics stays experimental. The deterministic suite passes 262/262.
- On final clean production commit `d0077fd`, astronomy v4 and theatre v5 each
  remained 12/12 as regression checks with 12/12 pack audits, 11/11 result
  comparisons and zero evaluator errors. V4 mean/median/P95 latency was
  5.4/5.2/9.7 seconds; v5 was 5.3/5.7/7.5 seconds. Both again rejected all 11
  generated query narrations, confirming that verified fallback remains the
  current explanation path. These reruns do not replace v5's first retained
  precommitted result or create new qualification evidence.

## 2026-08-07 — Analytics Expert Pack 0.1 reference

- Moved grant issuance out of the pack and into Mind & Memory's trusted control
  plane. It now verifies the saved conversation/dataset pair, ignores
  client-supplied prior history, appends only the current user turn when needed,
  and issues exact conversation- and request-scoped grants.
- Added an immutable local Analytics manifest plus runtime request/result
  validation for identities, capabilities, resources, permissions, grant ids,
  tools, model resolution, evidence, terminal states and failure receipts.
- Wrapped the existing conversational SQL path without changing its routing
  precedence. Dataset identity, schema, hidden categorical grounding queries and
  final execution all cross one injected DuckDB adapter with pinned hashes and
  no external access.
- Propagated Stop through file hashing, schema reads, grounding, SQL execution,
  planning and narration. Cancellation is terminal and never becomes a fallback
  or retry; provider and runtime failures now return stable typed outcomes.
- Passed the explicitly resolved local model id to Ollama and recorded it in the
  result/trace. General is live; Automatic currently reuses General; a different
  Custom model fails before any data or model access. No model is downloaded.
- Added focused registry, authority, cross-conversation, provider, cancellation,
  grounding-adapter, evidence-forgery, trace-compatibility and HTTP status tests.
- Fixed the hard audit's release blocker instead of weakening its test: DuckDB
  now runs in an isolated process killed on Stop or an absolute deadline covering
  hashing, import, preparation and execution. The former native interrupt could
  leave the process hanging indefinitely.
- Added synthetic integration coverage for the exact route order, saved
  conversation/dataset binding, reply metadata, typed HTTP failures, warnings,
  trace propagation and evidence-to-trace consistency. Malformed provenance is
  rejected both before the response header and before client persistence.
- Upgraded the sealed evaluator to runner 2.1.2. It records commit/dirty state,
  pack/model/context/quantization, Ollama, hardware, cold/warm state, summary
  latency and errors; every case now audits the visible answer and exact evidence,
  permission, grant, tool, model and terminal receipts.
- Rejected the initial runner-2.0 score as qualification-comparable after an
  independent audit found false-pass paths in result matching and numeric-only
  narration grounding. The cases, expected plans and gold SQL stayed frozen;
  comparator 1.0.0 now checks typed positional cells, duplicate multiplicity,
  deterministic ordering, truncation and an explicit two-decimal tolerance.
- Ran the unchanged 12-case astronomy suite at clean warm commit `8725d47`. It
  remained 10/12 (83.3%) with one exact-source semantics miss and one
  clarification instead of the required conditional-rate execution. All 12 pack
  audits and all 10 executed-result comparisons passed; evaluator errors were 0,
  and mean/median/P95 latency was 5.3/4.5/18.1 seconds. The stronger audit
  rejected every generated query narration, so all 10 query answers used a
  disclosed, persisted and visibly labelled verified fallback. No case, expected
  plan or gold result was removed or weakened.
- At this checkpoint the deterministic project suite passed 253/253 alongside
  the 60-case fixture validator, 15/15 memory precision and recall, lint,
  typecheck and the production build. The later semantic-repair section above
  records the superseding 262/262 tests and v5 transfer result.

## 2026-08-07 — Expert Pack Contract v1 foundation

- Drafted the versioned Expert Pack Contract while keeping Mind & Memory the
  sole privacy, permission, precedence, memory and final-synthesis control plane.
- Added model-independent TypeScript contracts for manifests, per-pack model
  assignments, bounded requests, evidence, receipts and stable failures. This
  is an interface foundation; runtime pack routing remains disabled.
- Enforced all three user model choices (`automatic`, `general`, `custom`), a
  one-generative-model v1 limit, explicit web permission, perfect critical-case
  qualification, privacy-preserving uninstall and rejection of unknown fields.
- Added six deterministic tests covering a valid Analytics-shaped reference,
  model choice, hidden authority, network access, resource limits,
  qualification, uninstall safety and request overrides.
- Deliberately deferred third-party pack trust, automatic model downloads,
  parallel large models, pack-authored UI and autonomous pack delegation.

## 2026-08-05 — Reproducible cross-model runtime profiles

- Reverified the public model registry and selected `qwen2.5:7b` as the general
  7B comparison profile; the coding-only variant would not test Rangabot's full
  conversation and memory contract.
- Preserved `llama3.2:3b` as the default because the local M1 Air has 8 GB RAM
  and the Qwen profile carries 16 GB guidance. Installation and evaluation are
  explicit; no app configuration is silently changed.
- Added a sequential matrix runner using the unchanged frozen conversation
  cases, a fixed per-profile context, private outputs and model unloads between
  runs. Memory-fit mismatches fail closed unless the operator explicitly opts
  into the risk.
- Propagated the bounded context setting through text, structured JSON and
  streaming requests so model comparisons measure the same orchestration
  budget rather than different Ollama defaults.
- Installed and verified the official `qwen2.5:7b` Q4_K_M artifact locally
  without changing `.env.local` or the default model. A deliberately selected
  three-case diagnostic passed 3/3 on both Llama and Qwen; it is not a complete
  suite result. Llama averaged 7.6 seconds. Qwen averaged 137.6 seconds, with a
  328-second cold first case, demonstrating severe 8 GB memory pressure.
- Traced that 328-second request to the old per-attempt timeout retry. Replaced
  it with one absolute deadline and deterministic simulations for cancellation,
  timeout, unavailable runtime, missing model, HTTP failure, empty output,
  malformed output and partial streams. No timed-out generation is silently
  attempted twice.
- Ran the complete frozen 22-case critical partition once per model at the same
  4096-token context. Llama scored 21/22 at 4.8 seconds mean latency and gave a
  materially false explanation of Python indentation. Qwen scored 21/22 at
  11.1 seconds; its only rubric failure said an exact Bitcoin prediction was
  “not possible” without inventing a number, but the frozen lexical rule did not
  accept that phrasing. The result remains a frozen failure rather than being
  rescored after inspection.
- Qwen then failed reviewer qualification at 1/12, so it is barred from live
  review. The critical run demonstrates one genuine reasoning improvement over
  Llama, but that did not justify making it the default or automatically routing
  user requests to it.
- Audited the Knowledge answer evaluator before cross-model use and found that
  checkpoints were not model-specific. Added explicit `--model` and
  `--num-ctx` controls plus model/context checkpoint isolation and result
  provenance, preventing Llama answers from contaminating a Qwen comparison.
- Ran a three-case Qwen Teacher Mode diagnostic after the isolation fix. The
  Python case completed and passed in 88.2 seconds; SQL and NumPy each exceeded
  the 180-second absolute deadline. The completed-case rate is 1/1, but the
  honest provisional floor is 1/3 with two execution errors. This is neither a
  full-suite score nor evidence that Qwen is practical for Teacher Mode on the
  local 8 GB machine.
- Removed the local `qwen2.5:7b` artifact after the evaluation decision,
  recovering about 4.7 GB. `llama3.2:3b` remains the configured chat model and
  `nomic-embed-text` remains available for local embeddings. The public registry
  entry and reproducible evaluation tooling remain for contributors with
  suitable hardware.

## 2026-08-04 — Schema-derived semantic-role resolver

- Split semantic-role selection from model operation planning. A deterministic,
  model-independent pass now ranks count targets, group grains, measures,
  secondary measures and temporal endpoints with explicit confidence.
- Integrated only unique high-confidence roles for grouped counts, averages of
  per-entity totals, distinct populations, durations, row-count ratios,
  thresholds, anti-joins and period growth. Absent or ambiguous roles fail
  closed with a clarification.
- Added unrelated clinical and media development schemas plus adversarial cases
  for relation-name/measure confusion, ambiguous populations and missing fields.
- Expanding the development suite first produced 7/9, exposing malformed model
  output and incomplete growth routing. Two later runs were dominated by local
  provider timeouts; those are retained as runtime failures, not quality scores.
- Fully resolved supported requests now bypass probabilistic model planning,
  while unresolved requests still use the same typed Ollama boundary. The final
  9-case development run passed 9/9 in 196 ms total without planner calls.
- The suite is explicitly development evidence and cannot replace a newly sealed
  transfer domain.
- Preflighted then ran the unseen astronomy v4 suite once: 10/12 (83.3%) in
  27.7 seconds. One correct distinct-count query failed the frozen exact-role
  rubric; conditional rate genuinely failed on malformed model output. Both
  remain failures and v4 is sealed.
- The ecology v3 result remains sealed at strict 3/13 and was not used as a
  question-specific tuning set. Astronomy v4 is the new candidate evidence but
  remains below the 90% transfer target.

## 2026-08-04 — Model-independent analytical semantics

- Added distinct-count and nested group-aggregate operations to the dynamic
  schema grammar used identically by every configured Ollama model.
- Separated probabilistic intent interpretation from trusted execution:
  operation-specific fields alone may affect joins, request-explicit
  categorical values are checked locally, and SQL is compiled deterministically.
- Proved the two motivating development questions locally—distinct students who
  studied Python returned 3 and average students per cohort returned 6—without
  adding those table names, values, questions or answers to production logic.
- Passed 185/185 deterministic tests, lint, typecheck, production build, privacy
  scan and an audit with zero known production vulnerabilities.
- Ran the new ecology-domain holdout only after the gates passed. The automated
  result was 6/13, but three passes were coincidental result matches with wrong
  semantics; strict readiness is 3/13. This exposed and fixed an evaluator
  governance gap: future cases may declare test-only expected semantic roles,
  and both meaning and result must match.
- Kept the failed ecology cases sealed as evidence. They will not be used for
  question-specific tuning; the next candidate needs general semantic-role
  resolution and another unseen transfer domain.

## 2026-08-04 — Persistent conversational data context

- Confirmed that filesystem approval already persisted locally, but the selected
  dataset was held only in React state and was explicitly cleared whenever a
  saved conversation reopened.
- Added a local SQLite `dataset_id` migration, validated create/update API
  boundaries, and per-conversation attach/remove persistence. Reopening a chat
  restores only metadata for an approval that still exists; revoked approvals
  fail closed.
- Broadened attached-data routing for natural exploration requests without
  treating unrelated uses of the word “data” as SQL intent.
- Added persistence, removal, positive-routing and false-positive regression
  tests. Dataset approvals are now explicitly ignored by Git.

## 2026-08-03 — Organic analytical-planning reset

- Audited the unpublished 26/50 candidate and found benchmark-domain regexes and
  templates. That result is withdrawn as evidence of organic improvement.
- Removed those templates and all benchmark table names from production
  analytical planners. Replaced them with schema-derived field enums, typed
  filters, key-derived join paths and a domain-neutral operation grammar.
- Reworked tests around a workforce schema and added a source scan preventing
  benchmark table names from returning to the production planners.
- Froze and ran a different 12-case logistics transfer suite exactly once. It
  passed 5/12. Failures were retained rather than tuned away; v1 is now sealed
  and any candidate improvement must use development fixtures plus a fresh
  unseen holdout.
- Corrected a numeric-grounding tokenizer defect where commas between adjacent
  JSON cells were mistaken for thousands separators. The 3/50 and 12/50 full
  baselines had no correct-result cases rejected solely by this defect, so they
  remain comparable and were not silently rescored.
- No medium milestone is claimed. The last valid unchanged development result
  remains 12/50, and the independent transfer result is 5/12.
- Added 16 cross-domain and adversarial validator tests covering workforce,
  manufacturing, and publishing schemas. The complete deterministic suite is
  now 176/176.
- The fresh library-domain v2 holdout recorded 6 passes, 4 genuine failures and
  2 invalid cases caused by broken reference SQL. Therefore its valid-case score
  is 6/10, not 6/12, and it is not a release pass. The suite is sealed and was
  not used for question-specific tuning.
- Hardened the holdout runner to execute every reference query before making any
  model call. This prevents evaluator defects from contaminating future learning.

## 2026-08-03 — Constrained analytical-plan compiler, increment one

- Replaced the model-authored SQL path with a small typed plan covering one
  aggregate, dimensions, filters, ordering and limits. Dynamic JSON grammar
  restricts actions, tables, fields, operators and sort targets to inspected
  schema values before parsing.
- Added deterministic compilation with quoted identifiers, inferred join paths,
  typed literals, requested-scope normalization, month ranges, status/Boolean
  semantics, and focused clarification for ambiguous comparisons. Invented
  fields, unsupported metrics and unsafe values fail closed.
- The unchanged full suite improved from 3/50 to 12/50: easy 9/10, medium 2/15,
  hard 1/20, extreme 0/5. Context results were enough 6/20, medium 2/15, less
  2/8 and none 2/7. The easy exit gate was met; later capability tiers were not.
- Mean latency was 47.7 seconds only because one local-provider timeout outlier
  reported 1,544.1 seconds; median was 17.9 seconds and P95 27.6 seconds. This
  outlier remains a provider/runtime defect and is not hidden from the result.
- Added targeted benchmark filters for development, but final claims use the
  complete unchanged partition or full suite—not targeted reruns.

## 2026-08-03 — Strict multi-table conversational analysis baseline

- Added native read-only `.duckdb` support without `ATTACH`, external access,
  mutation, or file writes; CSV and Parquet behavior remains unchanged.
- Added deterministic schema focusing that exposes relevant tables and required
  join bridges instead of overwhelming a small model with the full database.
- Built a private deterministic commerce fixture with eight related tables and
  a frozen 50-question suite: 10 easy, 15 medium, 20 hard, and 5 extreme cases;
  it includes enough, medium, less, and no-context requests.
- A pass requires the generated SQL result to equal an independent gold-query
  result and the narration to remain grounded. Clarification and unavailable
  cases must identify the correct boundary. The first complete
  `llama3.2:3b` run passed 3/50: easy 2/10, medium 0/15, hard 1/20, extreme 0/5.
  By context it passed enough 2/20, medium 1/15, less 0/8, and none 0/7.
- Failure audit: 14 invalid column/join queries, 4 syntax failures, 3 malformed
  decisions, and 26 wrong-result or wrong-boundary responses. The runtime and
  all 151 deterministic tests pass; the planner quality is the release blocker.
- Full answers, model SQL, correct answers, and interpretation judgments remain
  private under `data/evaluations/results/` and are excluded from Git.

## 2026-08-03 — Measured memory selection reliability

- Added a frozen 24-scenario synthetic selector audit that reads neither real
  chats nor the live memory database and measures precision and recall directly.
- Preserved the pre-change result: 73.3% precision (11/15) and 73.3% recall
  (11/15). Domain-scoped style rules leaked into unrelated requests, while
  related vocabulary such as PySpark/Spark and chart/plot was missed.
- Separated universal style preferences from subject-scoped instructions, added
  local topic families and lightweight token normalization, excluded saved
  technical choices contradicted by the current request, and made the newest
  same-purpose memory authoritative before ranking.
- The unchanged audit now passes all 24 scenarios at 100% precision (15/15) and
  100% recall (15/15), and is enforced by `npm run check`.
- The unchanged v1.0.11 end-to-end suite at clean commit `594d57e` completed
  60/60 without errors at 57/60 overall, 22/22 critical, and 6.6-second mean
  latency. Memory use, privacy, and precedence each passed 5/5. Two unrelated
  model-output failures were preserved; one honest-uncertainty failure is a
  documented evaluator false negative because a correct negated sentence still
  contains the raw forbidden substring `is unbiased`. No rubric was changed or
  result rescored in this increment.

## 2026-08-02 — Conversational verified analysis

- Replaced the query-workbench-first flow with a conversation-first analysis
  loop for explicitly attached approved datasets.
- Added analytical-intent and follow-up detection so unrelated conversation does
  not touch the dataset.
- Added local plan → validate → execute → narrate orchestration using bounded
  DuckDB and schema-only planning context.
- Added a strict numeric grounding audit. Unsupported numerical narration is
  discarded in favour of the verified result table.
- Added persistent calculation traces containing no local path or raw dataset,
  only the dataset name, exact query, row/timing limits, and SHA-256 receipts.

## 2026-08-02 — Schema-bound conversational SQL drafting

- Added an explicit **Use selected data in chat** action for approved datasets.
- Local Ollama receives column names and types, not dataset rows or file paths.
- Model output is parsed through a fixed JSON schema and the existing read-only
  SQL validator before it can appear in the review workspace.
- Chat Send remains distinct from **Review query** and **Run once**; neither
  preview confirmation nor execution occurs automatically.

## 2026-08-02 — macOS development crash recovery

- Reproduced false 404 responses for the app and API after repeated
  `EMFILE: too many open files, watch` errors.
- Confirmed the failure came from the macOS desktop session's 256-file soft
  limit, not DuckDB, the dataset registry, Ollama, or user data.
- Added a cross-platform launcher that selects one-second polling only on macOS.
- Verified `/` and `/api/datasets` return HTTP 200 without watcher errors.

## 2026-08-02 — Visible SQL approval workspace

- Added a local dataset allowlist UI and an inspectable SQL proposal card.
- Execution remains impossible until the user presses **Run once** on the exact
  previewed dataset fingerprint and query; rejection performs no execution.
- Added bounded result rendering and SHA-256 execution receipt visibility.
- Deliberately did not connect model intent or ordinary chat Send to execution.

## 2026-08-02 — Exact SQL approval protocol

- Added a private persistent allowlist for canonical CSV and Parquet files with
  list, approve, and revoke APIs. Revocation never deletes the source file.
- Added a five-minute SQL preview confirmation bound to the exact dataset ID,
  dataset SHA-256, normalized query, query SHA-256, and a random token whose hash
  alone is persisted locally.
- Confirmations are single-use and consumed even on a changed query or changed
  dataset attempt. Replay, expiry, token mismatch, revoked approval, and file
  modification all require a new preview.
- Added local preview and execute API boundaries, but deliberately left chat
  integration locked until the visible confirmation component exists.

## 2026-08-02 — Safe DuckDB execution foundation

- Selected DuckDB's supported Node Neo client instead of the deprecated Node
  package and pinned the reviewed binding release.
- Added an ephemeral SQL kernel for explicitly approved CSV/Parquet files with
  canonical-file validation, a 100 MB input ceiling, 256 MB DuckDB memory cap,
  two threads, bounded timeout, 200-row result cap, and SHA-256 receipts.
- External file access is enabled only for the approved import and disabled
  before user or model SQL is prepared. Mutation, multiple statements, file
  reopening, attachment, export, and extension loading are rejected by allowing
  exactly one prepared `SELECT` statement.
- This is intentionally backend-only. Chat execution remains locked until the
  dataset approval and exact-query preview flow is implemented.

## 2026-08-02 — Verified local reasoning ledger

- Added a conservative model-independent reasoning ledger that recognizes only
  locally verifiable relationships, computes them deterministically, and places
  the resulting facts in the current-turn contract.
- Initial repeats exposed an incomplete statistical invariant; tightened it to
  preserve the majority percentage, negative baseline, precision, and recall.
- Speedup arithmetic now uses the verified division result instead of trusting
  fluent model arithmetic. Missing verified facts are restored before final
  normalization, while unrecognized calculations remain model-generated.
- Three final targeted repeats passed 2/2. The unchanged complete v1.0.11 suite
  scored 59/60 overall, 22/22 critical, 5/5 reasoning, and 5.9-second mean
  latency. The prior comparable candidate was 56/60, 22/22 critical, 3/5
  reasoning, and 6.7 seconds.
- Status returns to **conditional pass**. Direct diagnostic usefulness remains
  4/5; exact-candidate critical repetition and human blind review remain open.

## 2026-08-02 — Premise and causal-reasoning hardening

- Compiled leading premises into the model-independent current-turn contract so
  models must verify them before answering instead of obediently extending a
  false claim.
- Tightened causal conformance: answers must explicitly state that correlation
  does not prove causation and identify a confounder; a deterministic generic
  third-variable safeguard is used only if the local repair still omits one.
- The two prior failures passed three targeted repeats after transparent scorer
  repair. A complete critical run passed 22/22 at 4.7 seconds mean latency.
- The subsequent complete suite rescored under v1.0.11 to 56/60 overall and
  22/22 critical at 6.7 seconds, but reasoning remained 3/5. Release verdict:
  **fail**. Next evidence-backed cluster is arithmetic and statistical reasoning.

## 2026-08-02 — Strict repeated-critical release gate

- Ran all 22 critical cases three complete times; no targeted run was promoted
  as release evidence.
- Repaired three proven evaluator false negatives transparently in v1.0.9.
  Preserved runs rescore to 20/22, 22/22, and 22/22.
- The first run still contains genuine false-premise and causal-reasoning
  failures. Intermittent critical failures therefore make the release verdict
  **fail**, despite the earlier complete-suite result of 57/60.

## 2026-08-02 — Adaptive-review qualification, rejected safely

- Prototyped a local draft-review/revision stage above the provider boundary and
  tested it against preserved conversation failures instead of assuming that a
  second model call improves quality.
- Rejected live activation after the same 3B model approved incorrect drafts,
  rewrote correct SQL guidance incorrectly, emitted invalid review structures,
  and increased targeted latency. The experiment never remained in the live
  response path.
- Added Ollama JSON-schema output support plus a frozen 12-case reviewer
  qualification: six bad drafts must be fixed and six good drafts must remain
  unchanged. `llama3.2:3b` scored 1/12, so it is explicitly unqualified.
- Fixed role-label leakage, meta-answer prompting, and newline-destroying word
  truncation. Versioned the evaluator at 1.0.7 after documenting a genuine
  p-value synonym false negative; no privacy exclusion or release gate changed.
- Added monotonic semantic-repair selection after a repair collapsed a valid
  explanation to three words. The affected critical case then passed 3/3.
- The final complete production-path run finished 60/60 with no errors at 56/60
  and 22/22 critical with 8.3-second mean latency. A documented tone-action
  synonym repair in v1.0.8 rescored the preserved output to 57/60 and restored
  every category to at least 4/5. Status is conditional pending the complete
  repeated-critical gate and human blind review.

## 2026-08-02 — Mind & Memory release architecture

- Replaced route-specific prompting with a documented shared control plane for
  current-turn constraints, bounded history, relevant approved memory, mode
  context, typed local generation, conformance, and response receipts.
- Added deterministic handling for unavailable actions, exact literals, and a
  missing-source question; hard formats are buffered and narrowly normalized.
  Semantic omissions such as an unnamed requested subject or missing causal
  confounder receive one local repair pass without benchmark-specific answers.
- Fixed memory supersession and preferred-name recognition, excluded current-
  turn conflicts before prompt construction, and removed orphan assistant turns
  from trimmed history.
- Propagated Stop into Ollama, introduced stable provider failure categories,
  and restricted automatic retry to one safe timeout.
- Deterministic validation is 121/121. The complete v1.0.6 candidate on
  `llama3.2:3b` completed 60/60 with no runtime errors but scored 52/60 overall,
  21/22 critical, and 6.6-second mean latency. It therefore fails the 54/60,
  22/22-critical, and per-category release gates. Targeted reruns are recorded
  only as diagnostics, never substituted for this complete result.
- Remaining failures expose both conformance variance and genuine 3B knowledge
  limits. No benchmark answer was hardcoded and no gate was weakened.

## 2026-08-02 — Public product showcase

- Captured the current Rangabot UI at 1280×720 using an empty conversation and
  public project intelligence only: fresh chat, Knowledge Brief, and Path to
  Mastery.
- Added a compact README showcase beneath the brand banner so the public landing
  page demonstrates the real product, local intelligence, and transparent
  capability roadmap.
- Documented privacy and refresh rules for future screenshots; personal chats,
  memories, repositories, local paths, and private vault documents are forbidden.

## 2026-08-02 — Public truth and frozen conversation baseline

- Confirmed the GitHub landing page still showed a stale pre-redesign Teacher
  Mode screenshot with Ollama offline; replaced it with the current Rangabot
  social banner and added an explicit pre-release reliability notice.
- Audited the private 2026-08-01 conversation result. Its 90% headline was only
  18/20 narrow cases, with one or two samples in most categories, reasoning at
  0/2, surface-level substring scoring, and no suite, commit, model, Ollama,
  hardware, context, or completion provenance. It is retained privately as an
  exploratory result and is not comparable to the frozen baseline.
- Versioned the Core Conversation Contract and expanded the frozen suite to 60
  cases: five cases across each of twelve required capabilities, with explicit
  critical privacy and trust cases and strict release gates.
- Added result provenance for Git state, model, Ollama, configured context,
  machine profile, cold/warm declaration, completion/errors, critical cases,
  per-capability numerator/denominator, and latency.
- Ran two complete 60-case diagnostics on `llama3.2:3b` Q4_K_M with Ollama
  0.32.4 on the 8 GB M1 host. Both completed 60/60 with no execution errors.
  The second preserved output scores 51/60 overall and 21/22 critical cases
  under the transparently repaired 1.0.2 rubric, with 7.2-second mean latency.
  Exact format, reasoning, adaptation/concision, and current-turn-over-memory
  remain below release gates. Cross-run case changes also confirm meaningful
  stochastic variance; one run must never be presented as mastery evidence.

## 2026-07-30 — Path to Mastery

- Added official contributor-claim governance: CODEOWNERS, merged-evidence
  validation, an opt-in claim template and node-level credits in the app.
- Audited project history and recorded Saketh's founder credit across 19
  implemented capabilities; no locked or merely proposed skill was claimed.
- Marked Path to Mastery unlocked after merged PR #52 and passing Linux and
  Windows validation.
- Established Rangabot's shared icon craft language: one 20-pixel grid, quiet
  monoline geometry, purposeful negative space and no platform-dependent emoji.
- Replaced functional glyphs throughout the main app and Path to Mastery, added
  design documentation and regression coverage for future contributors.
- Defined Rangabot's final state as an ever-loyal local-first personal assistant
  with permissioned, allowlisted web help only when local knowledge is missing.
- Added eight mastery paths and 40 subskills that double as the public backlog.
- Added strict Vision, Locked, Ready, In progress, Training, Unlocked, Mastered
  and Regressed states; merging code alone never unlocks a skill.
- Added an interactive connected mastery view with node details, scores,
  dependencies, evidence, acceptance criteria and the next task.
- Added canonical JSON, generated Markdown and validation that prevents unknown
  dependencies or unapproved web research from silently appearing unlocked.
- Reworked the first visual draft after direct user review: restored page
  scrolling, reduced the tree to two readable columns, reused the social banner,
  added hover/focus unlock guidance and linked full checklists.
- Added opt-in contributor achievements and locally stored portraits so public
  recognition never causes a hidden runtime request to GitHub.

## 2026-07-30 — Conversation-aware follow-up retrieval

- Added a bounded local query-planning step for context-dependent follow-ups.
- Vague questions such as “What about its limitations?” now carry the latest
  substantive user topic into hybrid Knowledge Vault retrieval.
- Self-contained questions remain unchanged, assistant prose is not copied into
  the search query, and the model still answers the user's original wording.
- Added regression coverage for contextual, standalone, and missing-context
  cases; the full 73-test suite and required quality checks pass.
- Confirmed the weekly welcome and Knowledge Vault reviews were already
  completed on 2026-07-28, so no unnecessary content churn was introduced.

## 2026-07-29 — Critical full-tree and GitHub audit

- Verified the public repository, branch protection, successful required CI,
  license, Discussions, Issues, secret scanning, push protection, and production
  dependency audit.
- Removed the unsafe heavy-model fallback and prohibited remote Ollama endpoints.
- Centralized and validated local runtime defaults, bounded stored/generated chat
  payloads, and added repository secret-content filtering.
- Corrected misleading evaluation summaries that treated timeouts as answer
  failures and included their timeout duration in answer latency.
- Updated the stale Discussions link, added defensive browser headers, updated
  PDF extraction, and documented unresolved findings in `docs/code-review.md`.
- Confirmed GitHub maintenance debt: the latest release trails `main` by 21
  commits, 31 remote branches remain, and automatic merged-branch deletion is off.

## 2026-07-29 — Adaptive grounding without a weaker gate

- Recorded the fresh 60-case result: 80.0% pass rate, 84.4% required-concept
  coverage, 91.7% grounding, 73.3% revision, 63.3% evidence/background
  separation, and 57.8-second mean latency. Two statistics cases timed out and
  remain retryable from the local checkpoint.
- Mapped each requested answer part to its strongest direct passage matches so
  the small local model receives a more explicit completeness checklist.
- Reordered grounding recovery: deterministic evidence/background separation
  now runs before any second generation, and the unchanged audit is rerun before
  revision can be skipped.
- Kept local revision as selective escalation for drafts that still cannot pass
  the same citation-coverage and lexical-support thresholds.
- A focused rerun of four previously failing cases passed 2/4, kept grounding at
  100%, required no second generations, and reduced mean latency to 34.4 seconds.
  Dashboard completeness and cross-mythology source synthesis still failed. A
  superficially passing leakage answer also conflated leakage with concept drift,
  exposing a terminology-reliability regression that aggregate scoring missed.

## 2026-07-29 — Evidence-planned Teacher Mode synthesis

- Used the completed 60-answer run as the baseline: 46.7% composite pass, 89%
  concept coverage, 51.7% grounding, 70% revision, and 50.6-second mean latency.
- Added deterministic subtopic and claim-to-source planning before drafting.
- Prevented a weak revision from replacing a better-grounded first draft.
- Repaired citation markers emitted as isolated paragraphs and added conservative
  citation recovery at twice the audit's lexical-support threshold.
- When mixed content still fails, separated supported vault paragraphs from
  explicitly unverified local-model background rather than hiding uncertainty.
- A fresh four-domain targeted run passed 4/4 with 100% concept and grounding
  coverage; 75% used the separation fallback and all still required revision,
  so first-draft reliability and latency remain unresolved.
- Reprocessing the original 60 saved answers through the new deterministic
  boundary raised composite pass from 29/60 to 52/60. This is a counterfactual
  re-score, not a substitute for the next fresh 60-answer run.

## 2026-07-29 — Sixty-question RAG benchmark

- Replaced the 13-question smoke test with 60 rubric-backed questions across ten
  subject groups, three difficulty levels, and explicit cross-source tasks.
- Added a complete Teacher Mode answer benchmark for concept coverage,
  grounding, forbidden claims, cited-source synthesis, revisions, and latency.
- Added per-subject and per-difficulty results while keeping answers and detailed
  reports private and Git-ignored.
- Established the honest retrieval baseline at 85%, then fixed implicit
  SQL/statistics classification and compact mythology/ML source titles.
- The same 60 questions now score 90% retrieval pass, 99.2% expected-source
  coverage, 100% contamination-free, and 98% passage-locator coverage.
- Remaining retrieval failures are concentrated in multi-book coverage and one
  cross-domain statistics-plus-visualization synthesis query.
- Hardened the long answer run after a 120-second generation timeout stopped at
  question 8: evaluation calls now allow five minutes, checkpoint every answer,
  continue after isolated errors, and resume only unfinished cases.
- A ten-subject generated-answer sample initially passed 60%, with 90.8%
  required-concept coverage, 70% grounding, 40% revision, and 61.6-second mean
  latency on `llama3.2:3b`. This is the first honest synthesis baseline, not a
  full 60-answer claim.
- The sample exposed bare `[N]` citations, overly broad background-section
  auditing, irrelevant-passage distraction, and weak evidence for a basic
  mean-versus-median question. Citation normalization and evidence-selection
  instructions were hardened; deterministic rescoring raised the same saved
  sample to 80%, while targeted generation confirmed supervised learning now
  passes and mean-versus-median remains a real unresolved quality gap.

## 2026-07-29 — Teacher Mode grounding review

- Added deterministic checks for substantive citation coverage, invalid source
  numbers, and weak lexical support between claims and cited passages.
- Added one bounded local-model revision when the first answer fails grounding.
- Added a visible warning when the revised answer still cannot meet the
  grounding threshold rather than presenting uncertain claims as verified.
- Preserved explicit Local model background sections without requiring false
  vault citations and kept ordinary/Smart chat streaming unchanged.
- Verified the full local route: a weak cross-validation draft was revised and
  returned with `revised-and-passed` in about 27 seconds on `llama3.2:3b`.

## 2026-07-29 — Measurable RAG retrieval quality

- Added a local evaluation harness so retrieval changes must demonstrate useful
  source selection instead of relying on anecdotal chat outputs.
- Added 13 starter questions across Python, SQL, PySpark, NumPy, pandas, machine
  learning, visualization, and three mythology traditions.
- Measured expected-source coverage, cross-subject contamination, source
  diversity, passage locators, and p50/p95 latency without exporting vault data.
- Kept personal textbook cases and detailed reports in explicit Git-ignored
  locations while retaining a reusable public starter suite.

## 2026-07-29 — Native local vector search

- Added a compact `sqlite-vec` table inside the private Knowledge Vault database
  for exact cosine search over existing local embeddings.
- Added automatic stale-index detection, rebuild after vault changes, an
  explicit rebuild command, and fallback to the previous JavaScript search.
- Indexed 17,986 768-dimensional passage vectors in 10.2 seconds, adding about
  54 MB to the local vault database.
- Reduced a 12-query, three-concurrent-batch mixed-subject stress run from
  31.6 seconds to 17.8 seconds. Native vector lookup itself measured about
  24 milliseconds; local query-embedding generation is now the main bottleneck.

## 2026-07-29 — Subject-aware retrieval guard

- Stress-tested 37,094 passages across statistics, ML, Python, SQL,
  visualization, and mythology queries.
- Added local subject inference for major Rangabot teaching domains.
- Excluded clearly cross-domain titled sources before final evidence diversity,
  while preserving relevant and uncategorized books.
- Added a regression case preventing Fluent Python from entering clustering
  evaluation evidence.

## 2026-07-29 — Accurate Knowledge Vault doctor result

- Corrected the doctor command so known incompatible files are reported as an
  informational notice rather than incorrectly classified as unindexed work.
- A healthy searchable vault now passes even when deliberately skipped sources
  remain in the inbox for user review.

## 2026-07-29 — Hierarchical Knowledge Vault ingestion

- Added a backward-compatible SQLite migration for passage heading, section
  path, and PDF page-range metadata.
- Added versioned ingestion so older compatible sources re-index once without
  requiring the user to delete or rebuild the vault manually.
- Preserved DOCX and HTML heading levels, Markdown headings, common plain-text
  chapter labels, and PDF page boundaries during chunking.
- Prevented overlap text from crossing section boundaries and contaminating a
  new section's metadata.
- Added hierarchy metadata to retrieval results and source labels supplied to
  Teacher and Smart modes.

## 2026-07-28 — Visible textbook-ingestion progress

- Added per-source progress before reading each Knowledge Vault file.
- Added visible extraction size, passage count, and embedding-batch progress for
  large textbooks.
- Added a two-minute timeout per Ollama embedding batch so ingestion cannot wait
  forever on an unresponsive local model.
- Compatible files fall back to a keyword-searchable index when embeddings are
  temporarily unavailable; rerunning ingestion can add embeddings later.

## Next approved milestone — Rangabot Learning Core

Rangabot will grow from a retrieval-assisted chatbot into a local knowledge
synthesizer. Retrieval remains an internal evidence tool; the user-facing result
must be an original, context-aware explanation built from the downloaded model,
multiple compatible books, and the relevant conversation.

### Approved capability backlog

1. Preserve document hierarchy during ingestion: book, chapter, section,
   heading, page, and passage.
2. Plan each knowledge request using its intent, subject, conversation context,
   and the user's demonstrated level.
3. Gather and rerank evidence across multiple books, then identify overlap,
   complementary explanations, and genuine source disagreements.
4. Synthesize a coherent answer using both cited vault evidence and clearly
   labelled local-model background instead of reproducing retrieved passages.
5. Add inspectable local learning memory for preferences, proficiency, progress,
   corrections, and user-approved conclusions.
6. Run a separate grounding and completeness review before returning important
   answers, revising weak drafts when necessary.
7. Build reusable cross-book concept summaries and relationships that can be
   regenerated whenever the vault changes.
8. Capture explicit feedback and corrections as reviewable quality signals and
   regression fixtures so improvement is measured rather than assumed.

### Learning and safety contract

- All source processing, memories, evaluations, and synthesis remain local.
- Every durable learned item records its origin, confidence, and update time.
- Conflicting interpretations remain visible rather than being silently merged.
- Users can inspect, edit, export, reject, and delete learned memories.
- Adding books updates the knowledge layer; it does not automatically retrain or
  mutate model weights.
- Fine-tuning may later be offered only from a reviewed, explicitly approved
  dataset with evaluation and rollback.

### First implementation slice

Start with hierarchical ingestion and source-aware multi-book retrieval. This is
the required foundation for later concept synthesis, persistent memory, and
quality evaluation, and it can be validated without changing model weights.

## 2026-07-28 — Knowledge Vault retrieval repair

- Found that the live index still referenced the pre-rename `/wan/` folder and migrated 23 records by content hash without duplicating their chunks.
- Fixed conversational stop-word pollution and BM25 score flattening; added title-aware hybrid reranking and a semantic relevance floor.
- Expanded answer context from three to five reranked passages and instructed Teacher Mode to ignore irrelevant evidence instead of discussing it.
- Made `knowledge:doctor` report unindexed, moved, stale, and textless sources.
- Added ingestion quality gates that reject empty HTML and image-scanned PDFs instead of indexing page-number markers.
- Verified live retrieval across Ramayana, Python namespaces, pandas, Egyptian mythology, and Greek mythology.
- Identified `valmiki_ramayanam.pdf` as a 339-page image-only scan. It now remains visibly unindexed until local OCR is available, instead of contaminating answers.

## 2026-07-28 — Word story quality hardening

- Reproduced the poor Ramayana document and traced it to a generic business-report fallback.
- Added story-collection, guide, and article genres plus warm/playful tones.
- Added hard gates that reject planning notes, source dumps, incomplete stories, and generic report scaffolding.
- Added story-specific Word rendering without the business purpose/audience table.
- Added a curated local Ramayana pack covering Rama's exile, Bharata's sandals, Hanuman's journey to Sita, and Jatayu's courage so `llama3.2:3b` cannot invent plot outcomes.
- Verified the exact chat scenario end-to-end. The resulting two-page DOCX contains four complete stories and was rendered to PNG for visual inspection.

## 2026-07-30 — Inspectable local memory

- Added a private SQLite memory store for explicitly approved preferences,
  user-provided facts, and standing instructions.
- Added a sidebar review panel with visible origin and confidence, plus create,
  edit, JSON export, and delete controls.
- Supplied a bounded set of approved memories to ordinary and Teacher Mode local
  chats while prohibiting silent inference or automatic profile building.
- Added validation and lifecycle tests; automatic proficiency tracking and
  memory import remain separate follow-up milestones.
- Hardened direct recall after a real name-memory failure: identity and memory
  review questions now resolve against approved records before model generation,
  including an explicit no-guess response when the requested fact is absent.

## 2026-07-31 — Visible memory-use receipts

- Added a persistent answer-level receipt showing when approved Local memory was
  supplied to the model and when deterministic direct recall answered instead.
- Preserved the receipt across conversation reopen and Markdown backup/restore.
- Added strict metadata validation so imported or API-supplied messages cannot
  invent arbitrary memory-use states.

## 2026-07-31 — Bounded Knowledge Doctor scans

- Traced the apparent Doctor freeze to synchronous hashing of the full 1.36 GB
  vault rather than to Ollama or embedding generation.
- Replaced full-file buffering with sequential streamed SHA-256 hashing and an
  immediate deep-scan progress message.
- Added a 30-second default overall deadline, a bounded environment override,
  and an explicit incomplete-check warning instead of an indefinite wait.
- Replaced Doctor's full passage-text materialization with a SQL aggregate that
  ignores page-marker-only chunks without loading the entire index into memory.

## 2026-08-01 — Review-first Local memory import

- Added strict parsing for versioned Rangabot memory exports with explicit
  provenance, 200-item, and 300 KB boundaries.
- Added a no-write preview that separates new memories, exact duplicates, and
  conflicts caused by matching IDs, kinds, or recognized identity subjects.
- Existing memories win by default; users must select each imported replacement
  and approve the complete review before a transaction writes anything.
- Added streamed API body limits and local lifecycle tests covering duplicate,
  conflict, replacement, and untrusted-export behavior.

## 2026-08-01 — Relevance-aware Local memory

- Replaced all-memory prompt injection with deterministic request matching and a
  six-item maximum, keeping unrelated personal facts outside the model context.
- Preserved broadly applicable response-style preferences while requiring topic
  or intent evidence for personal facts and technical instructions.
- Added persistent title-only receipts such as `Answer style` and `Preferred
  name`; saved values are never copied into the visible receipt.
- Added selector, privacy, metadata-validation, and receipt tests.

## 2026-08-01 — Chat-focused navigation

- Removed Knowledge Brief, Local memory, Path to Mastery, repository management,
  and the large privacy card from the conversation sidebar.
- Added a compact header utility rail for Brief, Memory, Mastery, local folders,
  and local-only status, with responsive icon-only behavior at narrower widths.
- Moved repository allowlisting, search launch, and revocation into an anchored
  folder popover so the capability remains available without crowding chats.
- Added structural tests that keep future non-chat tools out of the sidebar.

## 2026-08-01 — Conversation focus stack

- Reworked recent chats into a title-only resting state with no space reserved
  for hidden actions.
- Added a restrained focus animation: the hovered or keyboard-focused chat grows,
  reveals up to two title lines and its controls, while neighboring chats recede.
- Preserved pinned state with a minimal accent point instead of a permanently
  visible control.
- Redrew All chats and folder icons as layered local SVG linework and added
  regression tests for the interaction and icon contracts.

## 2026-08-01 — Mind & Memory quality foundation

- Added a synthetic, private end-to-end conversation benchmark spanning direct
  answers, hard instructions, follow-up continuity, corrections, ambiguity,
  reasoning, honest uncertainty, capability boundaries, tone, and memory safety.
- The baseline exposed a critical failure: the model admitted live data was
  unavailable and then invented an exact price. The shared conversation contract
  now explicitly prohibits that behavior and tells every configured model to
  respect current-turn corrections and hard output constraints.
- Memory retrieval now uses recent user context for short follow-ups, while
  unrelated facts remain excluded and the current request overrides a conflicting
  saved preference.
- Added bounded recent-history shaping so long chats do not crowd the newest user
  request out of a local model's context window.
- Kept all evaluated answers and timing data in an ignored local directory; no
  real conversation, saved memory, or model output was committed or uploaded.

## 2026-08-02 — Critical maintenance and weight audit

- Reconciled the checkout with merged PR #62 and audited runtime constants,
  dependencies, assets, generated files, GitHub metadata, issues and branches.
- Centralized product/repository identity and derived default model IDs from the
  reviewed registry instead of maintaining duplicate runtime literals.
- Followed current Next.js guidance by untracking generated `next-env.d.ts` and
  generating route types explicitly before TypeScript validation.
- Enabled unused-code compiler checks and removed the stale import they found.
- Eliminated the whole-project Turbopack trace warning by marking private vault,
  artifact, allowlist and approved-folder reads as runtime-only.
- Removed about 3 MB of unused mascot animation and stale screenshot assets; the
  live PNG/CSS mascot appearance is unchanged.
- Split infrequently needed Memory UI and Markdown/highlighting code from the
  initial client path. The main application-specific chunk fell from about 362 KB
  to 57 KB; the 301 KB renderer now loads when content first needs it.
- Enabled GitHub's automatic merged-branch cleanup, deleted only ten branches
  verified as merged into `main`, and closed completed issues #23 and #25.
- Kept safe loopback defaults, bounded limits, protocol header names, benchmark
  fixtures and product-policy thresholds explicit: these are reviewed constants,
  not accidental hardcoding.
# 2026-08-02 — Evidence-backed program mastery remap

- Replaced manually assigned mastery scores and states with calculations over
  146 acceptance criteria: verified = 1, partial = 0.5, planned/failed = 0.
- Audited 9 program epics and 45 capabilities, adding Platform & Release to cover
  governance, CI, setup, releases, and maintainability.
- Strict result: 46% weighted progress, 54/146 verified criteria, 8/45 unlocked
  capabilities, and 21 below gate. Natural conversation, Quality evaluation,
  and Path to Mastery are regressed instead of overstated.
- Remapped Saketh Viswanadha to 29 contributor claims backed by attributable
  merged PR evidence. Credit records work performed; it does not certify quality.
- CI now fetches complete Git history so both platforms verify cited historical
  merge commits instead of bypassing or weakening the evidence check.
- Corrected the public headline after strict review: Rangabot is 18% capability
  ready (8/45 unlocked), 37% criterion-verified (54/146), and 46% through
  weighted development. Only the first measure represents product readiness.
