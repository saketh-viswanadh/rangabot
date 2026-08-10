# Decision 0002: Public site, maintainer-local untracked website source

Status: accepted

## Decision

The Rangabot application, contributor tooling, tests, and product evidence remain
open source in this repository. The source used to operate the public
`rangabot.com` website is maintained in a maintainer-controlled, Git-ignored
local Sites workspace and is absent from the current tracked tree. A separately
versioned private publishing repository has not yet been established.

The website is an informational publishing surface, not a prerequisite for
building, testing, running, or contributing to Rangabot. Repository CI must not
depend on website source or website-only dependencies.

## Privacy boundary

Only public-safe, synthetic, merged, and evidence-backed information may be
copied from this repository into the website workflow. Private conversations,
memories, Knowledge Vault files, evaluation outputs, local paths, credentials,
and unpublished changes must never be included in website source or deployments.

The deployed website may remain publicly viewable. Public access to the website
does not grant access to the local Rangabot application or its private data.

## Consequences

- Contributors can reproduce the complete open-source Rangabot application
  without the website source.
- Website changes are reviewed locally and deploy only after maintainer
  approval. Moving that source to a durable private repository remains a
  follow-up because ignored files can be lost by destructive Git cleanup.
- The public repository links to the deployed website but does not validate,
  package, or publish it.
- Removing website files from the current tree does not erase copies already
  present in Git history, forks, clones, pull requests, or caches. Any history
  rewrite requires a separate explicit decision because it changes commit IDs
  and disrupts existing clones and pull requests.
