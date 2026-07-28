# Choosing a local model

Run `npm run setup` for guided selection. The machine-readable registry is
`config/models.json`; it records minimum memory guidance, intended uses, upstream
links and license-review notes.

For automation or a non-interactive installation:

```bash
npm run setup -- --model=llama3.2:3b --skip-pull
```

Omit `--skip-pull` only in an interactive terminal where Rangabot can visibly
ask before downloading models.

Model guidance is approximate. Available memory, quantization, context length,
other applications and Ollama versions all affect performance. A model being
listed does not mean its output is safe for consequential decisions.

Registry availability and artifact sizes were last checked against the official
Ollama library on 2026-07-28. Maintainers should update `verifiedAt` only after
rechecking identifiers, sizes, model cards and licenses.

To change models manually:

```bash
ollama pull MODEL_ID
```

Then set `OLLAMA_MODEL=MODEL_ID` in `.env.local` and restart Rangabot. The model
is never downloaded or changed silently. `nomic-embed-text` is configured
separately for Knowledge Vault retrieval through `OLLAMA_EMBED_MODEL`.

When contributing a model entry, include the exact Ollama identifier, upstream
model card, license, approximate hardware requirement, intended use, known
limitations and locally reproducible evaluation results.
