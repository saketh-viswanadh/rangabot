# Local execution architecture

Status: bounded SQL is available through conversation and an advanced manual workspace

Rangabot treats generated code as untrusted input. Mind & Memory remains the
control plane; SQL and future Python runtimes are subordinate tools that may
return evidence, never independent agents.

## Primary conversational sequence

1. A user explicitly selects a local CSV or Parquet file.
2. The user explicitly attaches that approved dataset to the current chat. This
   is persistent, revocable permission for bounded read-only analysis in that
   conversation; selecting a different or new chat clears the attachment.
3. A high-precision intent gate distinguishes analytical requests from ordinary
   conversation. Unrelated messages do not open or inspect the dataset.
4. Trusted semantic resolution handles supported unambiguous requests. Only an
   unresolved plan invokes Ollama, which receives bounded conversation plus
   column names/types—not dataset rows—and returns a typed plan, never SQL.
5. Rangabot validates the proposal. A fresh in-memory DuckDB instance imports
   only the canonical approved file, then disables external access before the
   untrusted SQL is prepared or run.
6. Exactly one `SELECT` statement runs with memory, thread, time, row, query,
   input-size, and output limits.
7. A trusted renderer receives the retained typed plan and bounded result. It
   enforces operation-specific aliases/cardinality, exact cells and units,
   explicit scope and display limitations, then structurally audits the complete
   answer. No second free-form model narration is authorized.
8. Rangabot stores the answer plus an inspectable calculation trace in the
   conversation. The trace has no local path or copied dataset.
9. Before success, the pack binds the runtime input fingerprint to preflight and
   the query fingerprint to the exact compiled query. Cancellation is rechecked
   after every awaited boundary. The connection and in-memory database are then
   destroyed.

## Implemented boundary

`lib/sql-runtime.ts` currently provides the tested execution kernel:

- CSV and Parquet only, maximum 100 MB;
- canonical regular files only;
- in-memory DuckDB, 256 MB and two threads;
- external access disabled after the one approved import;
- one prepared `SELECT` statement only;
- 10-second default timeout, capped at 30 seconds;
- 200 returned rows with visible truncation;
- lossless JSON-safe values;
- SHA-256 input and query identity in the receipt;
- no network, extension loading, mutation, attachment, export, or persistence.

## Approval protocols

Dataset approval is persistent, local, and revocable through `/api/datasets`.
It records the canonical path and public file metadata, never file content.

The advanced manual SQL workspace has a separate ephemeral confirmation.
`/api/analysis/sql/preview` returns
the exact query, dataset fingerprint, limits, expiry, and a random token. The
local store keeps only the token hash. `/api/analysis/sql/execute` consumes that
confirmation once and rejects replay, expiry, token mismatch, query changes,
dataset changes, or revoked approval. Confirmations expire after five minutes.

Conversational analysis uses the explicit chat attachment as continuing,
revocable permission instead of asking for a second click on every calculation.
The intent gate, validator and runtime limits remain mandatory. The model cannot
broaden access, mutate data or bypass these controls.

## Python follows SQL

Python will reuse the same approval and receipt contract, but requires a real
process sandbox: disposable directory, empty environment, no network, explicit
package allowlist, filesystem deny-by-default, CPU/memory/time/output limits,
and process-tree termination. A subprocess timeout alone is not sufficient.
