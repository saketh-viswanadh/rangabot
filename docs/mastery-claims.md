# Official mastery contribution claims

Path to Mastery records two different truths:

- a node's state describes Rangabot's currently verified product capability;
- a contribution claim remembers who materially helped build that capability.

Contribution credit remains even if a node later regresses. It does not let a
contributor change the node's score or state.

## Claim process

1. Open the **Mastery contribution claim** issue template and identify one
   existing node ID.
2. Describe your own concrete design, implementation, testing or documentation.
3. Cite merged Rangabot pull requests or commits. Planned and open work is not
   accepted as official evidence.
4. Explicitly opt into public recognition. Portrait use is separately optional.
5. A maintainer verifies the evidence and prepares or approves the registry PR.
6. The official owner applies the `mastery-approved` label.
7. Required Linux and Windows CI validate the registry and approval before the
   claim can merge.

## Protection model

`CODEOWNERS` assigns the canonical tree, contributor registry, validator and
generator to the official maintainer. Required CI independently rejects changes
to those files unless the PR carries the owner-controlled approval label.
Contributor handles and optional portraits are stored in the repository; the
local app never requests profile images from GitHub.

Direct edits, duplicate claims, unknown nodes, weak summaries, missing evidence,
remote avatar URLs and malformed pull-request or commit references all fail
validation.
