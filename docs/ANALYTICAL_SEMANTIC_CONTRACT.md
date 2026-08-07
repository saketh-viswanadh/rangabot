# Analytical semantic contract

Status: experimental · local-first · model-independent

Rangabot treats a local language model as an intent interpreter, never as the
execution authority. Every supported Ollama model receives the same dynamic JSON
grammar derived from the currently approved schema. No model name, benchmark
question, expected answer, business domain, table name, or categorical value is
allowed to change production behavior.

## Semantic roles

An executable request must resolve the following roles:

1. **Population** — which rows or entities are eligible.
2. **Entity** — what is counted distinctly, when applicable.
3. **Grain** — what defines one group before a nested calculation.
4. **Measure** — the schema field or row count being aggregated.
5. **Aggregation** — count, sum, average, minimum, or maximum.
6. **Filters** — only current-request values grounded in approved schema or
   verified as categorical values inside the approved local dataset.
7. **Relationships** — join paths inferred only from shared approved keys.
8. **Outer calculation** — an optional second aggregation across group results.

If a material role is ambiguous, Rangabot asks. It must not silently choose a
metric, population, date field, threshold meaning, causal explanation, or
unsupported statistic.

Before accepting an advanced model plan, a deterministic resolver independently
ranks schema candidates for count population, group grain, numeric measures and
temporal endpoints, as well as row-count denominators, relation thresholds,
unmatched relations and period grains. It uses normalized request/schema labels, identifier
topology and mention order. Only a unique high-confidence role may correct a
model field. The resolver returns ambiguity rather than selecting between close
candidates, and a relation name alone cannot silently become a numeric measure.

## Trust boundary

The model selects enum-constrained semantic roles. Trusted Rangabot code then:

- removes unused or unsupported model fields;
- repairs only algebra explicitly stated by the request;
- rejects placeholders and numeric threshold-to-identifier mutations;
- checks explicit categorical literals against the approved local dataset;
- repairs a categorical field only when exactly one approved field contains the
  requested value, and asks when several fields contain it;
- compiles one bounded read-only query;
- executes locally through DuckDB;
- permits narration only from verified result evidence.

Categorical grounding returns field/value existence only. It does not expose
dataset rows, send data to the network, or persist discovered values.

## Supported algebra

- simple aggregate with optional grouping, filters, ordering and limit;
- distinct population count;
- ratio and conditional rate;
- elapsed-duration average;
- grouped threshold count;
- period-over-period growth;
- average of per-entity sums;
- aggregate over grouped values, including average distinct entities per group;
- anti-join for entities without a related observation.

Window functions, cohorts, percentiles, correlations, forecasts and causal
claims remain unavailable until separately specified and transfer-tested.

## Evaluation governance

Development tests use multiple unrelated schemas and adversarial model plans.
Production-source scans reject fixture table names. A transfer claim requires a
newly frozen domain that was not used to design the implementation. Its first
complete result is retained, including failures; it cannot become a tuning set.

A result match alone is insufficient because synthetic data can make different
calculations coincide. Each future holdout case may therefore define test-only
expected semantic roles. A pass requires the normalized model plan to match
those roles and the compiled query result to match the independent reference.
Expected roles remain evaluation fixtures and are never imported by production
code.

The first ecology v3 run printed 6/13 under the older result-only rule. Manual
semantic review rejected three coincidental matches, leaving 3/13 defensible
passes. This is a failed transfer gate and evidence that semantic-role selection,
not SQL safety, is the current blocker.

The clinical role-development suite subsequently passed 9/9. It is explicitly a
tuning suite and may be rerun; it is not independent transfer evidence. The
strict ecology score remained the release baseline until astronomy v4 was run
once on the later candidate.

When every required role for a supported operation is high-confidence, trusted
code compiles the plan without calling a model planner. This avoids making
correctness and latency depend on model size, JSON compliance or provider
availability. Model planning remains the fallback for unresolved interpretation;
result execution and numeric narration grounding remain deterministic.

The first retained astronomy v4 transfer result passed 10/12 (83.3%) in 27.7
seconds. One query returned the correct distinct population through an
equivalent shared key but failed the frozen exact-field expectation; it remains
a failure rather than a retroactive scorer change. The conditional-rate case
genuinely failed because the fallback model emitted an unsafe plan. V4 is sealed
and below the 90% gate.

Those two failures subsequently became explicit development targets. V4 may now
be rerun only as regression evidence; the repaired implementation reached 12/12
without changing its cases, expected plans or gold SQL. Before production code
changed, theatre v5 was frozen at commit `f877d77` and all 11 reference queries
were preflighted without a model. Its first clean Expert Pack run at commit
`23f5e2c` passed 12/12 with all 12 pack audits, all 11 result comparisons and
zero evaluator errors. V5 is structurally isomorphic to v4, so this meets the
manifest's 90% single-run overall-score threshold on a precommitted domain-and-
name transfer check, not broad independent generalization. It does not establish
complete Analytics Pack qualification: every generated query narration was
rejected, required critical repetitions were not run, cross-model evidence is
absent and human usefulness is unmeasured.

Scope preservation is an invariant, not a best effort. If trusted auditing
cannot verify every denominator filter, the plan must clarify; it may not remove
that filter and execute against a wider population. Mixed Boolean polarity and a
distinct count with no evidenced qualifying relation also clarify. A bare
distinct population, one explicit Boolean condition, and an explicitly negated
categorical scope may execute only when each maps uniquely to the approved
schema.

Clean production commit `d0077fd` subsequently retained 12/12 on both v4 and v5
as regression checks, with all pack audits and executed-result comparisons
passing and zero evaluator errors. All 11 executed narrations in each suite were
again rejected. These later runs verify non-regression only; they do not replace
v5's first retained precommitted result or broaden the qualification claim.
