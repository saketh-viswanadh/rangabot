# Daily progress

## 2026-07-28 — Fix chat scrolling

- Fixed the conversation pane so long chats scroll independently while the header and composer remain visible.
- Added constrained grid sizing, scroll containment, a stable scrollbar gutter, and mobile-friendly dynamic viewport sizing.
- Preserved the unrelated generated `next-env.d.ts` working-tree change outside this update.
- Validation passed: `npm run typecheck`, `npm run lint`, and `npm run build`.

Next recommended item: add streaming Ollama responses with a Stop generation control.

## 2026-07-28 — Name the assistant Rangabot

- Renamed the user-facing application, page metadata, assistant greeting, brand mark, and documentation to Rangabot.
- Kept the existing repository and package identifiers stable to avoid unnecessary migration work.

## 2026-07-28 — Stream responses and stop generation

- Changed the Ollama integration and chat endpoint to stream generated text as it arrives.
- Added incremental response rendering and a Stop generation control.
- Added clean handling for interrupted, empty, failed, and unavailable response streams.

Next recommended item: persist conversation history locally with SQLite.

## 2026-07-28 — Apple Messages-inspired interface

- Refined Rangabot with frosted navigation surfaces, compact rounded chat bubbles, system typography, and iOS-inspired blue accents.
- Added a three-dot thinking animation while the local model is responding.
- Added a static Stopped state that replaces the animation when generation is cancelled.
- Added reduced-motion support for accessibility.

## 2026-07-28 — Colorful new-chat welcome

- Replaced the default assistant bubble with a minimal, colorful Rangabot welcome state inspired by the supplied layout reference.
- Added a rotating offline collection of quotes, thoughts, and a developer joke for every new chat.
- Added two compact prompt starters for brainstorming and coding; they only prefill the local composer.

## 2026-07-28 — Introduce Ranga

- Created Ranga as an original warm-orange tiger cub with a polished, minimal 3D sticker finish.
- Replaced the generic letter mark with Ranga in the sidebar, new-chat welcome, and assistant messages.
- Kept motion purposeful: Ranga animates gently on the welcome screen and runs only while the model is actively thinking.
- Added a complete version 2 sprite atlas for future expressions, movement, and directional interactions.

## 2026-07-28 — Local conversation history

- Added SQLite-backed local conversation persistence using Node's built-in
  database API, with no external service or runtime dependency.
- Added recent-chat navigation with create, reopen, update, and delete behavior.
- Kept the database under the Git-ignored `data/` directory so personal chats
  cannot be committed accidentally.
- Added a database lifecycle test covering the full local CRUD flow.

Next approved item: Markdown and syntax-highlighted code rendering with copy controls.

## 2026-07-28 — Rich coding responses

- Added local Markdown rendering for headings, lists, links, quotes, dividers,
  inline code, and GitHub-style tables.
- Added syntax highlighting for fenced code blocks with language labels and
  one-click Copy controls.
- Kept raw HTML disabled and opened external links separately.
- Added focused tests for inline-versus-block code and language detection.

Next approved item: model management and active local model selection.

## 2026-07-28 — Golden Ranga and illuminated thinking

- Replaced the colorful tiger mascot with a minimal charcoal golden-retriever
  shadow, using a restrained warm-gold outline for clarity at small sizes.
- Added quiet idle breathing and blink motion, plus a focused processing loop
  while the local model responds.
- Redesigned the active assistant bubble with a moving multicolor light edge
  and an internal light runner inspired by modern ambient voice interfaces.
- Added a synchronized gold-and-blue mascot glow that stops with generation.

The optional full directional pet atlas remains under visual QA and is not used
by the chat interface until its final edge gate passes.

## 2026-07-28 — Pastel themes and message replies

- Added persistent light and dark appearance modes with sand, sage, and
  lavender pastel palettes instead of reducing themes to white or black.
- Reworked surfaces, bubbles, controls, and text around shared contrast-aware
  color tokens, and made Ranga's golden tone respond to the selected palette.
- Simplified Ranga to a static illustration with one slow, restrained breathing
  motion; active generation no longer swaps to a busy running sprite.
- Added a subtle message-row hover treatment and an accessible Reply action.
- Added a cancellable reply preview in the composer, a quoted reference in the
  sent message, and local-model context explaining which message is referenced.
- Browser QA covered dark sand, light lavender, long conversations, and reply
  selection without horizontal layout movement.

## 2026-07-28 — Expanded welcome collection

- Expanded the offline new-chat rotation from four entries to 27 short quotes,
  developer jokes, and original Rangabot thoughts.
- Moved the collection into a dedicated typed module so daily additions stay
  reviewable and do not clutter the chat interface.
- Added a test requiring all three categories, at least 24 entries, short copy,
  and no duplicate text.
- Kept the runtime fully local: the app never fetches welcome content from the
  internet.

## 2026-07-28 — Local projects and curious Ranga

- Added local SQLite project folders with create, select, rename, and delete
  controls, plus project-filtered chat history.
- New conversations inherit the selected project. Deleting a project safely
  moves its chats back to All chats instead of deleting conversation history.
- Kept project organization separate from filesystem access; projects grant no
  permission to read a repository or folder.
- Added extremely subtle cursor-following movement to Ranga and two infrequent
  CSS butterflies on the empty state. Ranga makes one restrained curious tilt
  as a butterfly passes nearby.
- Used only lightweight CSS transforms and respected reduced-motion settings;
  no new mascot rendering or animation assets were introduced.

## 2026-07-28 — Local Knowledge Vault and Teacher Mode

- Built a private 4 GB Knowledge Vault with incremental hashing, SQLite FTS5,
  local embeddings, storage accounting, and PDF/DOCX/HTML/Markdown/text parsing.
- Installed the 274 MB `nomic-embed-text` model locally through Ollama and
  indexed 14 starter documents into 1,577 embedded teaching passages.
- Added official Python tutorial material, official Spark/PySpark material, and
  public-domain Indian, Greek/Roman, and Egyptian mythology starter texts with
  license metadata and editorial warnings for dated interpretations.
- Added Teacher Mode, hybrid retrieval, strict evidence instructions, inline
  source citations, and explicit behavior when local evidence is insufficient.
- Added visible New this week and New this month reports plus vault storage use.
- Verified retrieval against Python exception handling and exercised a complete
  Indra teaching answer from local passages with citations.
- Added ingestion and retrieval tests. Private books and generated indexes stay
  excluded from Git.
