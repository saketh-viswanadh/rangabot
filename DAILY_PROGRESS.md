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
