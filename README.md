# Rangabot

A beautiful, local-first assistant for private chat, coding, brainstorming and
teaching from your own documents. Rangabot uses downloaded Ollama models and a
local Knowledge Vault; cloud handoff remains disabled.

![Rangabot — private local AI with a golden-retriever guide](docs/media/rangabot-social-preview.png)

> **Reliability status:** Rangabot is active pre-release software. Core chat,
> local memory, retrieval, and document creation work today, but capability
> quality varies with the installed model. The frozen conversation benchmark
> and its strict acceptance gates are documented in
> [the Core Conversation Contract](docs/CORE_CONVERSATION_CONTRACT.md); a merged
> feature is not automatically a mastered capability.

## Product showcase

### A calm local workspace

Start with a private conversation, choose local or knowledge-assisted routing,
organize chats into projects, and reach memory, folders, and mastery without
turning the interface into a control panel.

![Rangabot fresh conversation workspace with local model status, projects, themes, and conversation starters](docs/media/rangabot-product-home.png)

### Local intelligence and an honest roadmap

| Knowledge Brief | Path to Mastery |
| --- | --- |
| Meaningful technical developments, primary links, and local-vault status in a focused reading pane. | Every capability exposes its score, state, dependencies, and unlock criteria instead of implying that unfinished work is complete. |
| ![Rangabot Knowledge Brief showing locally saved data-science developments](docs/media/rangabot-product-brief.png) | ![Rangabot Path to Mastery showing its public capability roadmap](docs/media/rangabot-product-mastery.png) |

All showcase content is synthetic or public project metadata. No personal chat,
memory, repository content, or private Knowledge Vault document is shown.

## First run

1. Install Node.js 24+ and [Ollama](https://ollama.com/).
2. Run `npm install`.
3. Run `npm run setup` for guided model selection and private vault setup.
4. Run `npm run doctor` to verify the installation.
5. Start with `npm run dev` and open `http://127.0.0.1:3000`.

Experienced users can copy `.env.example` to `.env.local` and use the manual
model guidance in [docs/models.md](docs/models.md).

The server binds only to the local computer by default.
Rangabot also rejects non-loopback Ollama URLs, preventing an environment
configuration mistake from silently sending chats or vault evidence to a remote
model server.

## Current milestone

- Local chat interface
- Local-only / smart-routing / Codex mode controls
- Ollama availability and model detection
- Streaming local Ollama chat responses
- Stop generation control
- Local SQLite conversation history with reopen, search, pin, Markdown backup/restore and delete controls
- Chat-focused sidebar with a compact top rail for Brief, Memory, Mastery,
  approved local folders, themes, privacy, and model status
- Title-first conversation focus stack with readable hover expansion and
  on-demand pin/delete controls
- Markdown responses, GitHub-style tables, syntax-highlighted code, and copy controls
- Local project folders and project-scoped chats
- Explicit local repository allowlisting with reversible access approval
- On-demand scoped code search with bounded, line-numbered local file previews
- Explicit code-preview attachment to a chat, revalidated at send time for local Ollama only
- Conversational Word creation with local requirement gathering, DOCX validation, rendered previews and download
- Private 4 GB Knowledge Vault with PDF, DOCX, HTML, Markdown, and text ingestion
- Hybrid local keyword and embedding retrieval
- Per-answer `HYBRID` or `KEYWORD ONLY` retrieval status, so an unavailable
  embedding model never degrades silently
- Conversation-aware follow-up retrieval that carries the latest user topic into
  locally searched questions such as “What about its limitations?”
- Teacher Mode with passage citations and explicit evidence limits
- Automatic local Knowledge Vault lookup for informational questions in Smart mode
- Weekly and monthly sourced subject-intelligence briefs
- Dedicated Knowledge Brief panel with news cards, vault status and app changelog
- Offline welcome library with 100 quotes, 100 jokes and 100 thoughts, plus a 60-item no-repeat window
- No cloud transmission
- Interactive **Path to Mastery** at `/mastery`, generated from the same strict
  capability data used by the public contributor backlog

Conversation data stays in `data/rangabot.db` on this computer. The database and
its journal files are excluded from Git.

Repository approvals stay in the private, Git-ignored
`data/repositories.json` file. Adding a repository records only its canonical
folder path. Selecting an approved repository opens on-demand code search.
Rangabot reads only eligible text/code files after an explicit search, skips
secrets, symlinks, dependencies and build output, and never creates a background
repository index.
An attached preview is visibly listed above the composer before sending. Saved
chats retain only the repository, file and line-range reference; the raw source
preview is read again at send time and supplied only to the local Ollama model.

### Local SQL execution foundation

Rangabot includes a private SQL workspace backed by a read-only DuckDB execution
kernel for explicitly approved CSV and Parquet files. Open **Analyze**, allow a
local dataset, enter one `SELECT`, review its exact query, fingerprint and limits,
then choose **Run once** or **Reject**. Each approval expires after five minutes
and is consumed on its first execution attempt. The kernel disables external
access before untrusted SQL, applies resource and row limits, and returns an
inspectable execution receipt. Ordinary chat messages and model output cannot
trigger execution; model-proposed SQL remains a later, separately gated step. See
[`docs/LOCAL_EXECUTION_ARCHITECTURE.md`](docs/LOCAL_EXECUTION_ARCHITECTURE.md).

## Artifact skills

Rangabot now creates new `.docx` files through normal chat. Ask it to make a Word
document at any point; it remembers the active document request, asks one natural
follow-up at a time for missing requirements, then creates the file from the
conversation. The configured local Ollama model produces the structured draft,
while deterministic code applies styles, stores the artifact under
`data/artifacts/`, validates it, and renders local previews when LibreOffice and
Poppler are installed. Creative requests use genre-aware layouts and must contain
finished reader-facing content; planning notes and generic source-material
fallbacks are rejected. A curated local Ramayana story pack provides dependable
child-friendly plot facts when smaller models cannot safely retell the episodes.
Existing-file editing and the remaining artifact abilities
are separate backlog items. See [the artifact delivery plan](docs/ARTIFACT_SKILLS.md)
for the ordered backlog and quality contract.

Run `npm run setup` to initialize the private artifact directory and
`npm run doctor` to check whether optional Word page-preview tools are available.
DOCX creation still works when those tools are absent, but Rangabot will show a
visual-review warning instead of claiming that page rendering passed.

## Knowledge Vault

Put documents in `data/knowledge/inbox/` and run:

```bash
npm run knowledge:ingest
```

The importer hashes every file, skips unchanged material, extracts text locally,
splits it into small teaching passages, builds an SQLite FTS5 index, and creates
embeddings through the local Ollama embedding model. PDF extraction includes
quality validation: empty HTML, image-scanned PDFs, and page-marker-only output
are rejected rather than being advertised as searchable knowledge. Run
`npm run knowledge:doctor` after adding sources; image-only PDFs must first be
processed with a local OCR tool such as OCRmyPDF.
DOCX, HTML, Markdown, and plain-text files are also supported.

Knowledge Doctor streams file signatures and stops its deep synchronization scan
after 30 seconds instead of appearing frozen on a large vault. The basic document,
passage, storage, and compatibility status still prints first. For a deliberate
long scan, set `KNOWLEDGE_DOCTOR_TIMEOUT_MS` from `1000` to `300000` milliseconds,
for example `KNOWLEDGE_DOCTOR_TIMEOUT_MS=120000 npm run knowledge:doctor`.

Ingestion format v2 preserves document, heading hierarchy, section path, and PDF
page ranges on each passage. DOCX and HTML headings are retained, Markdown
headings are interpreted directly, and common plain-text chapter/section labels
are detected. Existing compatible vault files migrate automatically through one
full local re-index; later unchanged runs skip them normally.

Semantic retrieval uses a compact native `sqlite-vec` index stored inside the
private Knowledge Vault database. Rangabot builds it automatically from existing
embeddings on the first semantic search and invalidates it whenever indexed
documents change. You can also rebuild it explicitly with:

```bash
npm run knowledge:vector-index
```

This does not re-read books or regenerate embeddings. If the native extension
cannot load on a supported system, retrieval safely falls back to the existing
JavaScript similarity scan instead of making the vault unavailable.

Measure retrieval quality against the local vault with:

```bash
npm run knowledge:evaluate
```

The 60-question starter suite spans ten subject groups and three difficulty
levels. It checks expected-source coverage, cross-subject contamination,
multi-source retrieval, passage locators, latency, and per-subject performance. Detailed results are
written to a private Git-ignored directory. Contributors can add a private suite
at `data/knowledge/evaluations/my-vault.private.json` and run it with
`npm run knowledge:evaluate -- --file=data/knowledge/evaluations/my-vault.private.json`.
Private evaluation files may name personal textbooks and must never be committed.

Run the slower end-to-end Teacher Mode benchmark with:

```bash
npm run knowledge:evaluate:answers
```

It generates and locally reviews all 60 answers, then measures required-concept
coverage, grounding, forbidden claims, cross-source citation synthesis, revision
rate, and latency. Use `-- --sample=10` for one case per subject,
`-- --limit=5`, or `-- --subject=statistics` for smaller diagnostic runs. Full
runs can take a long time on lightweight local hardware.
The runner allows five minutes per local generation, catches isolated failures,
checkpoints every completed answer, and automatically resumes the same selected
suite. If it is interrupted or a model call times out, rerun the identical
command instead of starting over. Override the evaluation-only timeout with
`-- --timeout-ms=600000` when exceptionally slow hardware needs ten minutes.
Execution errors are excluded from completed-case quality and latency averages;
an interrupted run also prints a conservative overall pass floor until retries
finish.

Select **Teacher mode** in Rangabot to retrieve relevant vault passages before
the chat model answers. Teacher Mode is instructed to cite the numbered local
sources, identify gaps, and preserve conflicting historical or mythological
interpretations. It may add clearly labelled background from the downloaded
local model, but never presents that material as source-verified or current.
Before showing a Teacher Mode answer, Rangabot audits substantive paragraphs
for missing, invalid, or weakly supported citations. It first attempts fast,
deterministic evidence/background separation and requests one local-model
revision only when the unchanged audit still fails. A grounding warning appears
if that selective revision remains insufficient. This quality gate buffers
Teacher Mode answers until review finishes; ordinary and Smart-mode responses
continue streaming.
Teacher Mode also builds a visible-to-the-model evidence plan before drafting:
requested subtopics, source labels, query/source overlap, and a strict writing
contract. If revision still mixes supported and unsupported material, Rangabot
conservatively attaches a missing citation only when one passage has strong
lexical support, then separates remaining content into **Vault-grounded answer**
and **Local model background** sections. It never silently labels weakly matched
background as vault evidence.

The evidence plan also maps each requested part of a question to up to two
matching passages. If the first draft misses the grounding threshold, Rangabot
first tries the deterministic separation locally and rechecks the same gate. It
requests a slower second model generation only when that safe transformation is
not enough, preserving citation reliability while avoiding unnecessary work.
When several books contain strong matches, Rangabot reserves evidence space for
multiple sources and asks the model to connect their ideas rather than reciting
each passage separately. Weak books are not included merely to create diversity.
Title-level subject guards also remove clearly cross-domain books while leaving
uncategorized sources available for ordinary relevance ranking.

**Smart routing** also searches the vault automatically for informational and
subject-related questions. Responses visibly show `LOCAL · KNOWLEDGE VAULT`
when retrieval was used. Smart mode may fill evidence gaps from the downloaded
chat model and labels vault citations; Teacher Mode is the citation-first option
for deeper teaching with explicit evidence boundaries.

Private source files and generated indexes are Git-ignored. The tracked
`SOURCE_MANIFEST.json` contains only public starter-source metadata; weekly and
monthly reports describe meaningful changes without publishing book content.

Ask **“What’s new in data science this week?”** in Teacher Mode to read the
saved local intelligence brief. These briefs cover meaningful developments in
the subjects themselves—not Rangabot implementation work—and include dates,
why each item matters, evidence type, source links, and indexing status. The
current data-science pack adds official NumPy 2.5, pandas, scikit-learn, and
DuckDB learning/release material. Briefs are indexed too, so they remain
available offline after the weekly source check.

### Inspectable local memory

Open **Local memory** in the sidebar to save a preference, user-provided fact,
or standing instruction. Rangabot never infers durable memories from a chat:
each item requires an explicit **Approve and remember** action and records its
origin, confidence, and timestamps in the private local SQLite database
`data/rangabot-memory.db`. Rangabot deterministically selects at most six
memories relevant to the current request; unrelated saved facts are not placed
in the model prompt. Broad answer-style preferences remain available when they
apply across subjects. The panel supports review, editing, JSON export,
and deletion; no memory is sent to a remote service. Answers visibly show
**MEMORY** only when selected context was supplied and add safe titles such as
**Answer style** or **Preferred name**—never the saved value itself. **DIRECT
RECALL** identifies a fact resolved deterministically rather than left to model
improvisation.

Use **Import JSON** to restore or migrate a Rangabot memory export. Import is a
two-step local review: new items, skipped duplicates, and conflicts are shown
before any write. Existing memories win every conflict by default; replacing one
requires selecting that specific imported version and then approving the review.
Imports are capped at 200 memories and 300 KB, require explicit user-approved
provenance, and never contact a cloud service.

### Conversation quality evaluation

Run `npm run conversation:evaluate` to stress the configured local model against
synthetic conversations covering helpfulness, format compliance, follow-up
continuity, corrections, uncertainty, reasoning, tone, and Local memory safety.
The versioned 60-case suite balances twelve capability groups with five cases
each. It records the suite version, Git commit, model, Ollama version, context
configuration, host profile, cold/warm state, timing, and execution errors.
Critical privacy and truthfulness cases are reported separately and must reach
100%; the overall target is at least 90%, with no capability below 80%.
The evaluator never reads real chats or the live memory database. Full answers
and latency are written only to the ignored local directory
`data/evaluations/results/`, making regressions inspectable without publishing
private model output. `npm run conversation:evaluate:baseline` preserves the
pre-orchestration behavior for diagnostic comparison. The earlier 20-case
exploratory result is not comparable with the frozen v1 suite and must not be
presented as a product-quality score.

Use `npm run conversation:evaluate -- --critical-only` for a repeated critical
trust diagnostic. It is deliberately marked as a partial selection and cannot
replace the complete-suite result. The current request path and invariants are
documented in the [Mind & Memory release architecture](docs/MIND_MEMORY_ARCHITECTURE.md).

`npm run conversation:reviewer:qualify` tests whether the configured local model
is safe to use as an answer critic. Qualification requires 12/12: six incorrect
drafts corrected and six correct drafts preserved. A failed qualification exits
non-zero and never enables review in the app. Full reviewer outputs remain in
the ignored private evaluation directory.

Ordinary chat now uses a provider-independent Rangabot contract and a bounded
recent-history window. Relevant approved memories may shape an answer, but the
latest explicit user correction always wins and unrelated memories remain
outside the model request.

## Next milestones

1. Add conversation-aware query planning and multi-book evidence synthesis using the
   downloaded model, vault sources, and relevant chat context.
2. Validate inspectable local memory across chat sessions, then add cross-book concept summaries.
3. Add draft, grounding, revision, feedback, and regression-evaluation loops so
   improvement is measured rather than assumed.
4. Continue the artifact roadmap with existing-Word editing, PDF, email drafting,
   long-form writing, technical documentation, presentations, and spreadsheets.

Model management remains deferred. Cloud/Codex handoff remains disabled pending
a separately approved disclosure and consent design.

## Contributing

[Path to Mastery](docs/PATH_TO_MASTERY.md) is the criterion-audited public
program map and backlog: 9 epics, 45 capabilities, and 146 independently
assessed criteria. Scores and states are calculated from the governed merged-PR
[evidence registry](content/mastery-evidence.json), never typed by hand. Official
contribution claims must use the Mastery contribution issue template, cite
merged evidence and pass the [official approval process](docs/mastery-claims.md);
direct self-awards are rejected.

Rangabot welcomes community development. Read
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), the
[architecture](docs/architecture.md), [privacy model](docs/privacy.md), and
[model guide](docs/models.md). Interface contributions should follow the
[Rangabot design language](docs/design-language.md). Run `npm run check` before submitting a pull
request. Codex is optional; all required maintenance paths are normal scripts,
documentation and GitHub workflows.

New contributors can browse
[`good first issue`](https://github.com/saketh-viswanadh/rangabot/labels/good%20first%20issue)
and [`help wanted`](https://github.com/saketh-viswanadh/rangabot/labels/help%20wanted)
tasks, or introduce themselves in
[GitHub Discussions](https://github.com/saketh-viswanadh/rangabot/discussions).

CI validates Linux and Windows on every pull request; macOS is covered by the
documented clean-clone release rehearsal. Starter-source licensing and the
local-download-only policy are documented in
[docs/source-licensing.md](docs/source-licensing.md).

Source code and documentation use Apache-2.0. Original Ranga artwork uses CC BY
4.0 with attribution. The Rangabot naming policy is documented in
[BRANDING.md](BRANDING.md).

The latest severity-ranked engineering audit is in
[docs/code-review.md](docs/code-review.md).
