# Official mastery contribution claims

Path to Mastery records two different truths:

- a node's state describes Rangabot's currently verified product capability;
- a contribution claim remembers who materially helped build that capability.

Product readiness is calculated from criterion assessments, so contributors
cannot directly edit scores or states. Contribution credit remains even if a
node later regresses. Each non-planned criterion cites the governed merged-PR
registry; a merged PR proves work landed, while the criterion assessment records
whether its exact acceptance gate passed.

## Claim process

1. Open the **Mastery contribution claim** issue template and identify one
   existing node ID.
2. Describe your own concrete design, implementation, testing or documentation.
3. Cite merged Rangabot pull requests or commits. Planned and open work is not
   accepted as official evidence.
4. Explicitly opt into public recognition. Portrait use is separately optional.
5. A maintainer verifies the evidence and prepares or approves the registry PR.
6. After the final push, the official owner or another write/admin maintainer
   applies the `mastery-approved` label. If it was already present, remove and
   reapply it; applying it before a push does not approve the new commit.
7. The trusted workflow verifies who applied the latest label, stamps only that
   exact pull-request head SHA, and required Linux and Windows CI validate the
   registry before the claim can merge.

## Protection model

`CODEOWNERS` assigns the canonical tree, contributor registry, validator and
generator to the official maintainer. The repository also contains a dedicated
`Mastery governance / mastery-governance` workflow. It runs on
`pull_request_target`, reads only GitHub-owned metadata from the trusted
base-branch workflow, never checks out or executes pull-request code, checks
renamed files by both old and new path, and fails closed if GitHub's paginated
metadata is incomplete. Its only write permission is `statuses: write`, used to
record an approval receipt for the exact current head after GitHub confirms the
label actor has write/admin repository permission. Every push changes the head
SHA and therefore invalidates the old receipt until an authorized maintainer
removes and reapplies the label. All workflow files, `CODEOWNERS`, and the
governance checker are themselves protected paths.

This source change does **not** modify GitHub branch protection. After this
workflow is merged and has run once, the repository owner must add
`Mastery governance / mastery-governance` as a required status check on `main`.
Until that setting is applied, the workflow is visible audit evidence rather
than a guaranteed merge gate. CODEOWNERS requests a review, but the GitHub
branch currently requires zero approving reviews. Requiring a CODEOWNER approval
remains a future decision after a second trusted maintainer exists.

Contributor handles and optional portraits are stored in the repository; the
local app never requests profile images from GitHub.

Direct scores, direct states, duplicate claims, unknown nodes, wholly planned
capability claims, weak summaries, missing evidence, non-attributable PRs, and
remote avatar URLs all fail validation.
