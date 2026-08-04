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
