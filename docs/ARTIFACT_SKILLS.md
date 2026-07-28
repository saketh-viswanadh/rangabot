# Artifact skills delivery plan

Rangabot will add one local artifact ability at a time. Each ability must ship as
a complete vertical slice with its own input flow, deterministic renderer,
validation, preview, tests, privacy notes and documentation. Backlog status does
not imply that a file format is already supported.

## Shared quality contract

Every artifact ability must:

1. Collect a structured brief before generation.
2. Validate required content and expose assumptions.
3. Use deterministic templates and renderers for file structure and styling.
4. Validate the generated file independently of the language model.
5. Render a visual preview and check clipping, overflow and broken layouts.
6. require explicit user review before the artifact is treated as final.

Quality checks should return a visible report with passed checks, warnings and
repairs. A weak local model may require more revision, but it cannot bypass the
deterministic format and preview gates.

## Ordered backlog

### A0 — Artifact foundation — prepared

- Typed local skill registry and dependency order.
- Shared quality-gate contract.
- Fresh-chat entry points for email and document work.
- Private output location: `data/artifacts/` (Git ignored).

### A1 — Professional Word document creation — available

- Create new `.docx` files from a structured brief.
- Provide report, proposal, meeting-note and technical-document templates.
- Validate document structure and render pages for visual inspection.
- Show a local preview and quality report before download.

### A1b — Existing Word document editing — next candidate

- Upload or select a `.docx` through an explicit local flow.
- Preserve the original and apply bounded, trackable changes.
- Re-run structural, privacy and rendered-page validation before download.

### A2 — PDF reports

- Produce print-ready summaries and reports from validated content.
- Validate page size, fonts, links, page count, overflow and accessibility basics.

### A3 — Email drafting

- Draft locally with audience, intent, tone and length controls.
- Provide critique and alternative versions.
- Do not send email; sending remains a separate integration and approval decision.

### A4 — Writing studio

- Outline, draft, revise, critique and maintain voice for long-form writing.
- Add genre-specific rubrics without mixing them into business-document rules.

### A5 — Technical documentation

- Use explicitly attached repository context for READMEs, architecture notes,
  setup guides, API documentation, release notes and troubleshooting guides.
- Generate Mermaid diagrams when they improve understanding.
- Never claim uninspected project behavior as fact.

### A6 — Presentation decks

- Generate `.pptx` files with narrative structure, speaker notes and visual QA.
- Check text overflow, contrast, alignment and slide density.

### A7 — Spreadsheets

- Generate `.xlsx` files with typed tables, formulas, charts and data validation.
- Recalculate and verify formulas independently before delivery.

## Definition of done for each ability

- Works without internet access after local dependencies are installed.
- Stores artifacts and temporary renders under ignored local data paths.
- Has unit tests, representative fixtures and at least one rendered golden sample.
- Passes privacy, format, content and visual validation.
- Documents limitations and model-dependent judgment clearly.
- Ships through its own branch and pull request before the next ability begins.
