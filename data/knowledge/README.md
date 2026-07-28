# Rangabot Knowledge Vault

Put personal learning material in `inbox/`.

Planned ingestion flow:

1. Add PDF, DOCX, HTML, Markdown, or plain-text files to `inbox/`.
2. Run `npm run knowledge:ingest` from the Rangabot project directory.
3. The importer extracts and normalizes text locally, skips unchanged files,
   then builds keyword and embedding indexes under `indexes/`.
4. Choose Teacher mode in Rangabot to retrieve cited passages without uploading
   source files.

The initial storage budget is 4 GB. Configure it with
`KNOWLEDGE_BUDGET_BYTES` before importing if this changes later.

The `inbox/`, `processed/`, and `indexes/` directories are ignored by Git. Do
not place secrets, credentials, private keys, or material you are not permitted
to copy into the vault.
