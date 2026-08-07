# Trusted analytical narration contract

**Contract version:** 1.0.0

**Analytics Pack:** 0.2.0
**Status:** deterministic contract implemented; Analytics remains experimental

This contract governs how Rangabot turns a verified local SQL result into the
answer shown in chat. It does not qualify analytical planning, SQL correctness,
or broad usefulness by itself.

## Why the contract exists

The former path asked a local model to write unrestricted prose and then tried
to approve that prose with a lexical audit. A diagnostic run on the unchanged
theatre v5 regression suite attempted 11 narrations and accepted 0. All 11 used
the safe table fallback. The private diagnostics classified 11 unsupported-
language failures, five false limitations, and six unsupported-number failures.
The model often stated the correct result, but then added unverifiable caveats,
converted values, or invented limitations.

That architecture made fluency compete with correctness. It also added a model
generation to every successful calculation, even when one verified scalar was
already the complete answer.

## Trust boundary

The trusted path is:

```text
typed semantic plan
  -> bounded read-only DuckDB result
  -> typed facts and operation-defined units
  -> canonical renderer
  -> structural audit
  -> answer plus matching evidence claims
```

The renderer never reads model-authored plan explanations. It derives labels
only from the validated operation, schema-bound fields, grounded filters, typed
parameters, and execution receipt. Every displayed cell refers to an exact row
and column in the bounded result.

A local model can still resolve an analytical plan when deterministic semantic
resolution is insufficient. It no longer authors calculated facts or final
narration. When the semantic resolver and renderer are both deterministic, the
receipt and calculation trace correctly omit model provenance because no model
was invoked.

## Required invariants

Every successful narration must satisfy all of these rules:

1. The plan is retained as a typed basic or advanced plan; it is never reduced
   to untyped prose for narration.
2. Every rendered cell fact has an in-bounds row and column reference and its
   value exactly matches the execution result.
3. Every operation has an exact expected output grain, column count, alias, and
   scalar cardinality. An unexpected runtime shape fails closed before display.
4. Percent and hour units bind only to the expected output column of a typed operation. A suggestive alias
   such as `success_pct` cannot create a unit claim in a basic aggregate.
5. Result row count, row shape, runtime truncation, and row limit must agree.
   Inconsistent adapter output fails closed.
6. The user-visible answer must equal the canonical rendering of the validated
   plan and result. Post-render mutation is rejected.
7. Numerical tokens must originate in the typed plan, returned cells, or exact
   display/receipt metadata. Model-authored explanation text is not evidence.
8. Every verified filter is rendered with field-first wording. Conditional-rate
   base, denominator, and numerator scopes are distinct. If an extreme filter
   list is display-bounded, the omission is explicit and the complete query
   remains in the calculation trace.
9. Long cells, bounded row and column displays, and runtime truncation are disclosed
   exactly. A complete result must never receive a false limitation.
10. Markdown links, images, emphasis, code, email autolinks, HTML-like text,
   control characters, and bidirectional controls in local data are neutralized
   before ReactMarkdown rendering.
11. Evidence claims use the same canonical narrative facts as the answer. The
   evidence receipt, trace, and answer cannot describe different executions.
12. The Analytics Pack independently verifies that the runtime input fingerprint
   matches the preflight identity and that the query fingerprint matches the
   exact compiled query. It copies validated safety flags instead of inventing
   them.
13. No narration may infer cause, quality, recommendation, business meaning,
    significance, or an unexecuted statistic.

## Supported presentation

- One-cell results receive a direct operation-aware answer.
- Conditional rates and period growth receive an explicit percent unit.
- Duration averages receive an hours unit without converting or rounding the
  returned value.
- Anti-joins remain identifier lists, including when exactly one identifier is
  returned; a single ID must not be presented as a count.
- Grouped and multi-column results use a bounded Markdown table.
- Qualified schema labels disambiguate colliding fields, including acronym-heavy
  identifiers; implementation enum words are not exposed as prose.
- Empty results state that no matching rows were returned and explicitly avoid
  treating absence from the result as proof of real-world absence.
- Runtime-truncated results and displays above 20 rows are marked partial.

## Frozen evaluator

Run:

```bash
npm run conversation:evaluate:sql:narration
```

Frozen suite `analytical-narration-frozen-v1` contains 44 public-safe synthetic
cases and makes zero model calls. It covers all nine advanced operations, all
five basic aggregates, scalar/list/table/empty/null outputs, percentages,
negative and zero values, truncation, displays above 20 rows, long cells,
wide results, four-plus and bounded filter scopes, separate numerator and
denominator populations, half-open periods, hostile Markdown/HTML-like strings,
email and image autolinks, Unicode/bidirectional controls, colliding acronyms,
duplicate values, and multiple numeric columns.

The scorer reports canonical positive cases separately from adversarial
mutation rejection. Mutations forge unsupported numbers, cell values, fact IDs,
cell bounds, and canonical fields; six independent invalid-result cases exercise
wrong aliases, columns, rows, widths, and zero-column output. The current result
is 44/44 canonical and 222/222 rejected adversarial/invalid cases. Full outputs
are private and Git-ignored.

On clean implementation commit `45d3ff1`, unchanged astronomy v4 and theatre v5
Expert Pack regressions each pass 12/12 with zero evaluator errors, 11/11
structurally valid trusted narrations and zero model-authored narration attempts.
Theatre v5 mean/median/P95 latency is 210.1/221/237 ms. The preserved clean
free-form baseline at `b8a3938` was 5,014.8/5,023.5/8,018 ms with 0/11 accepted
narrations, so the mean fell 95.8% after removing the second model call. These
are same-suite regression measurements; they do not replace v5's first retained
transfer result.

Passing this suite establishes renderer determinism and structural grounding.
It does not establish broad analytical planning, statistical reasoning, causal
interpretation, cross-model planning quality, or blind human usefulness.

## Deferred extension

Future richer interpretation may let a model choose emphasis only through a
schema whose values are existing fact IDs. Trusted code must still render every
word, number, unit, and limitation. Free-form calculated narration cannot be
reintroduced without a separately frozen scorer, critical repetitions, and an
explicit contract revision.
