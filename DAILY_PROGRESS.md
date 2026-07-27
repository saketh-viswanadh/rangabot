# Daily progress

## 2026-07-28 — Fix chat scrolling

- Fixed the conversation pane so long chats scroll independently while the header and composer remain visible.
- Added constrained grid sizing, scroll containment, a stable scrollbar gutter, and mobile-friendly dynamic viewport sizing.
- Preserved the unrelated generated `next-env.d.ts` working-tree change outside this update.
- Validation passed: `npm run typecheck`, `npm run lint`, and `npm run build`.

Next recommended item: add streaming Ollama responses with a Stop generation control.
