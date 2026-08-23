# SQL capability update — 2026-08-23

## What entered the product source

This change integrates the domain-neutral SQL improvements that survived the
August regression work:

- relationship-aware schema linking using inspected primary and foreign keys;
- typed semantic context for approved table and column descriptions, aliases,
  and confirmed joins;
- request decomposition into bounded relational, temporal, ranking, window,
  rate, anti-join, and complete-population operations;
- an intent contract that rejects a plausible query when its operation, grain,
  population, relationship, or temporal scope does not match the question;
- execution-guided candidate comparison with read-only validation and a
  fail-closed clarification when the evidence is ambiguous; and
- deterministic model controls and trusted result narration.

These mechanisms are schema-derived. Production code contains no benchmark
table names or benchmark answer keys. The user question remains the sole source
of requested intent; semantic context may explain an approved schema but cannot
grant permission or add an operation.

## Evidence

Two disclosed internal matrices became engineering regression suites after
their first runs:

| Suite | First look | Post-disclosure regression | Correct interpretation |
| --- | ---: | ---: | --- |
| Unseen-schema readiness, 720 cases | 571/720 (79.31%) | 720/720 (100%) | Identified defects closed on a disclosed matrix; not an independent holdout. |
| Business-analyst holdout, 640 cases | 146/640 (22.81%) | 624/640 (97.50%) | 16 underspecified target-variance prompts clarified instead of guessed. |

The external BIRD Mini-Dev audit is the important counterweight:

- question-only baseline: **1/500 (0.2%)**;
- typed semantic context: **18/500 (3.6%)**;
- size-eligible cases: **18/400 (4.5%)**;
- challenging cases: **0/102**; and
- size-eligible mean latency: **55.4 seconds**.

The BIRD improvement shows that explicit schema meaning and confirmed
relationships help. It also proves that RangaBot is **not yet a general SQL
expert**. Reliable open-world query composition, candidate completeness, large
database support, and latency remain release blockers for that claim.

## Allowed claim

RangaBot has materially stronger, safer schema-grounded SQL planning in source,
with strong disclosed-regression results and a measurable external-context
gain. It should still be presented as an experimental local analytical
assistant whose query and calculation trace must be reviewed—not as universally
reliable natural-language-to-SQL.
