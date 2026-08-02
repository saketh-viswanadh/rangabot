# Local execution architecture

Status: approval protocol implemented — not yet exposed in chat

Rangabot treats generated code as untrusted input. Mind & Memory remains the
control plane; SQL and future Python runtimes are subordinate tools that may
return evidence, never independent agents.

## Approved sequence

1. A user explicitly selects a local CSV or Parquet file.
2. Rangabot shows the proposed query, dataset name, limits, and expected output.
3. The user approves that exact execution.
4. A fresh in-memory DuckDB instance imports only the canonical approved file.
5. External access is disabled before untrusted SQL is prepared or executed.
6. Exactly one `SELECT` statement runs with memory, thread, time, row, query,
   input-size, and output limits.
7. Rangabot returns structured rows plus an execution receipt. The LLM may
   interpret this result but must not alter or invent it.
8. The connection and in-memory database are destroyed.

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

## Approval and confirmation protocol

Dataset approval is persistent, local, and revocable through `/api/datasets`.
It records the canonical path and public file metadata, never file content.

SQL confirmation is separate and ephemeral. `/api/analysis/sql/preview` returns
the exact query, dataset fingerprint, limits, expiry, and a random token. The
local store keeps only the token hash. `/api/analysis/sql/execute` consumes that
confirmation once and rejects replay, expiry, token mismatch, query changes,
dataset changes, or revoked approval. Confirmations expire after five minutes.

It is deliberately not connected to the chat route yet. The next increment must
show this preview in the conversation UI and require a visible user click. A
model must never turn ordinary conversation into silent execution.

## Python follows SQL

Python will reuse the same approval and receipt contract, but requires a real
process sandbox: disposable directory, empty environment, no network, explicit
package allowlist, filesystem deny-by-default, CPU/memory/time/output limits,
and process-tree termination. A subprocess timeout alone is not sufficient.
