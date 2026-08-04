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
Ollama library on 2026-08-05. Maintainers should update `verifiedAt` only after
rechecking identifiers, sizes, model cards and licenses.

To change models manually:

```bash
ollama pull MODEL_ID
```

Then set `OLLAMA_MODEL=MODEL_ID` in `.env.local` and restart Rangabot. The model
is never downloaded or changed silently. `nomic-embed-text` is configured
separately for Knowledge Vault retrieval through `OLLAMA_EMBED_MODEL`.

`OLLAMA_NUM_CTX` fixes the active context budget so results can be reproduced
across model profiles. Rangabot defaults to 4096 tokens on limited-memory
hardware. A model's advertised maximum context is not a safe default for every
machine.

## Cross-model evaluation

List the installed registered profiles without loading them:

```bash
npm run conversation:evaluate:matrix -- --list
```

The matrix runner executes one model at a time, unloads it between profiles and
keeps full answers under the Git-ignored private evaluation directory. Its safe
default runs only the frozen critical trust cases:

```bash
npm run conversation:evaluate:matrix -- --models=llama3.2:3b,qwen2.5:7b
```

Use `--full` only for a planned complete 60-case comparison. Use `--ids=ID,ID`
for a small diagnostic sample; selected cases are never reported as a complete
suite. If a profile exceeds the machine's registry memory guidance, the runner
stops before loading it. `--allow-undersized-memory` is an explicit override,
not a claim that the model will run comfortably.

On an 8 GB Mac, keep `llama3.2:3b` as the default. `qwen2.5:7b` is an optional
registry profile whose 4.7 GB model artifact leaves little headroom for macOS,
Next.js and runtime context. It was removed from the tested machine after the
evaluation below. Contributors who deliberately install it should close
memory-heavy applications, use the 4096-token profile and never run both models
concurrently.

The first frozen critical comparison on the local 8 GB M1 profile recorded
21/22 for both models. Qwen averaged 11.1 seconds versus Llama's 4.8 seconds.
Manual inspection found that Qwen correctly rejected a false Python premise
that Llama repeated, while Qwen's single rubric failure was an honest “not
possible” response omitted by the frozen lexical variants. The rubric and
recorded score were not changed after seeing the answer. The Qwen registry entry
therefore remains useful for opt-in reasoning comparisons on suitable hardware,
but it is not an automatic quality tier. It also failed the reviewer gate at
1/12 and must not revise live answers.

To compare Teacher Mode answer quality on a small, subject-balanced Qwen sample:

```bash
npm run knowledge:evaluate:answers -- --model=qwen2.5:7b --num-ctx=4096 --sample=5 --timeout-ms=180000
```

Start with five cases on an 8 GB machine. This evaluator performs generation and
grounding review, so it is substantially heavier than retrieval-only
`npm run knowledge:evaluate`. Checkpoints and result files are isolated by model,
context and selected cases; a Qwen run cannot reuse Llama answers. Full answers
remain private and Git-ignored.

The first three-case Qwen Teacher Mode diagnostic on the local 8 GB M1 profile
completed only one case: it passed in 88.2 seconds, while the SQL and NumPy
cases each exceeded the 180-second absolute deadline. Its provisional floor is
therefore 1/3. Qwen is not recommended for routine Teacher Mode on this hardware
and was removed locally after this test; the command remains useful for
controlled evaluation on hosts where the model is deliberately installed.

When contributing a model entry, include the exact Ollama identifier, upstream
model card, license, approximate hardware requirement, intended use, known
limitations and locally reproducible evaluation results.
