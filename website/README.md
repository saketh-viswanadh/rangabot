# Rangabot website

The public, privacy-safe product website for Rangabot. It is intentionally
isolated from the locally running assistant and contains no chats, memories,
Knowledge Vault material, dataset contents, repository approvals or private
evaluation answers.

## Local preview

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Verification

```bash
npm test
npm run lint
npm audit --omit=dev
```

The rendered-route tests cover the home page and every public route, confirm the
starter preview was removed and guard against common private-data filenames.

## Hosting

The website uses the Sites-compatible vinext build. `.openai/hosting.json`
contains only the Sites project identifier after the first private deployment;
there are no D1 or R2 bindings in version one.

Public publishing requires explicit maintainer approval. The initial Sites
deployment is private for review.
