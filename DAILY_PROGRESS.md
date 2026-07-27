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
