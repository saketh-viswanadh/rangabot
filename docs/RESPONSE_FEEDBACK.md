# Local Response Feedback Pulse

Status: **included in the 1.2.0 source release; exact packaged eligibility is
still candidate-bound and is not a signed-desktop release claim**.

## User contract

Only completed assistant responses managed by the durable turn lifecycle are
eligible. The visible group is labelled **Was this response helpful?** and has
two toggles: **Helpful** and **Needs improvement**. Selecting the other option
changes the rating; activating the selected option clears it. The control uses
native buttons, `aria-pressed`, keyboard focus, a non-colour selected marker,
and a polite live status.

Successful actions say exactly:

- `Feedback saved locally`
- `Feedback changed locally`
- `Feedback cleared`

If the same-origin local write is not confirmed, the prior selection is
restored and the control says `Couldn’t save feedback on this device. Try
again.` Feedback never mutates or regenerates the answer and makes no training
claim.

## Local-only data boundary

The private SQLite row contains only:

- the opaque lifecycle turn ID;
- `helpful`, `needs-improvement`, or `NULL` when eligible but unrated;
- the immutable generation candidate digest;
- the UTC response-completion day; and
- minimal created/updated timestamps.

It stores no prompt, answer, title, reason, memory, attachment, user/device
identity, model output, or personal field. The browser uses Rangabot's guarded
same-origin loopback API; there is no outbound request, telemetry, or
third-party SDK. Feedback retention equals conversation retention because the
row cascades from its turn when a conversation is deleted. Clearing a rating
keeps the eligibility row so the denominator remains correct.

No existing response is backfilled. Legacy, imported, demo, failed, cancelled,
identity-less, and pre-feature responses are therefore ineligible.

## Candidate identity

`config/response-feedback-candidate.json` is a deterministic manifest of every
Git-visible candidate file except the manifest itself. Each entry carries only
a repository-relative path, byte count, and SHA-256. The manifest has no clock
or host data.

The candidate digest is SHA-256 over the approved base commit plus the
post-edit manifest SHA-256. The runtime build key is a bounded version derived
from that digest. A successful production build also writes a deterministic
SHA-256 manifest of its `.next` runtime artifacts, excluding only mutable Next
caches, diagnostics, trace output, and the artifact manifest itself. Next's
generated external-package links are accepted only when they resolve inside
this candidate's `node_modules`; both the link target and resolved package
bytes are hashed. Production
startup verifies that artifact before spawning Next and supplies the child an
immutable in-process identity receipt; this avoids rehashing the full build on
every answer. Development rechecks source when generation is claimed because
its files may change while the server remains open. The build and launchers
recompute source evidence; added, removed, or changed source is `dirty`,
unrelated lineage or a mismatched Next build/artifact is `mixed`, and missing
evidence is `unknown`. Only `known` identity is captured when generation is
claimed and may create an eligible feedback row. The protected local runtime
endpoint `/api/runtime/candidate` exposes state and digests, never manifest
paths.

This is source provenance, not a signed supply-chain attestation. It does not
identify the local model, user, machine, chats, memories, or private data.
The manifest is frozen only through the approved-base command
`npm run feedback:candidate:freeze`; the check command never blesses changes.

## Daily aggregate exchange

After a UTC day has closed, an operator may explicitly write one private JSON
artifact into an existing local incoming directory:

```sh
npm run feedback:export -- --day=YYYY-MM-DD --output=/absolute/private/incoming/response-feedback.json
```

The command refuses unknown/dirty/mixed identity, current or future UTC
windows, non-absolute output, symlink output directories, and inconsistent
counts. It uses Rangabot's private atomic writer; POSIX systems enforce
owner-only file modes, while Windows protection follows the current user's OS
profile and ACLs. It never opens or writes a Control Center database.

The exact allowlisted envelope is:

```json
{
  "type": "response_feedback_daily",
  "data": {
    "schemaVersion": 1,
    "repository": "rangabot",
    "build": "0.1.0+rfp.<candidate-prefix>",
    "buildDigest": "<64 lowercase hex candidate digest>",
    "sourceVersion": "0.1.0",
    "dirty": false,
    "day": "YYYY-MM-DD",
    "windowStart": "YYYY-MM-DDT00:00:00Z",
    "windowEnd": "YYYY-MM-DDT00:00:00Z",
    "eligibleResponses": 0,
    "helpful": 0,
    "needsImprovement": 0,
    "rated": 0,
    "unrated": 0,
    "generatedAt": "YYYY-MM-DDTHH:MM:SSZ",
    "sourceStatus": "COMPLETE",
    "validationStatus": "VALID"
  }
}
```

No extra data keys and no row IDs cross the boundary. `rated = helpful +
needsImprovement`; `unrated = eligibleResponses - rated`. Changing a rating
moves one count without changing `rated`; clearing decreases `rated` without
changing `eligibleResponses`. Control Center computes response rate only when
the denominator is known and positive.

An explicit valid zero-count artifact is an observed zero, not missing data.
`NOT_RUN`, `INCOMPLETE`, `MISSING`, and `STALE` remain distinct consumer-side
states; the successful producer command emits only `COMPLETE` / `VALID`.
