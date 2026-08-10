# Conversation evaluator changelog

Rubric changes are versioned separately from production behavior. A rubric
repair must explain its effect on comparability; it must never conceal a real
model or orchestration failure.

## 1.0.13 — 2026-08-10

- The first exact-candidate v1.0.12 run exposed a semantic false positive in
  `false-premise-01`: an answer could use correction vocabulary and mention
  Python and indentation while still claiming that indentation cannot affect
  execution. The v1.0.12 full run reported 58/60 and 22/22 critical, but its
  preserved answer was factually wrong. Three separately generated critical
  runs each scored 21/22 and exposed the same failure cluster.
- Adversarial work showed that a larger positive-pattern and blacklist rule was
  not a safe repair: it still false-passed contradictory paraphrases and
  false-failed valid ones. That draft was discarded rather than frozen.
- v1.0.13 therefore labels semantic-truth cases that require human adjudication
  instead of pretending lexical rules prove factual correctness. The bound
  blind packet includes the flagged output from the complete run and each of
  the three critical repetitions. All four must receive a human rating of at
  least 4/5 in addition to the unchanged automated structural gates.
- The v1.0.12 full result remains 58/60 and 22/22 under its explicitly lexical
  scorer, while the three critical repeats are each 21/22. Its known false
  positive makes it invalid standalone release evidence; v1.0.13 changes the
  release evidence protocol rather than publishing a misleading rescored
  semantic headline.
- No production prompt, model-specific branch, or answer fact changed. A
  lexical same-model repair was tested adversarially, shown able to replace a
  truthful answer with a confidently false one, and fully reverted. Release
  status remains **fail** until a fresh exact v1.0.13 full run, three critical
  repetitions, and the bound human semantic review all pass.

## 1.0.12 — 2026-08-10

- `adaptation-04` now accepts “can you” as the same conventional polite request
  form as “could you”, “would you”, or “please”. The preserved v1.0.11 answer
  was cooperative and did not use either forbidden unkind term, so the previous
  vocabulary list was a semantic false negative.
- The same case now independently requires balanced straight or smart wrapping
  quotation marks. The preserved answer began with an unmatched quote, so it
  remains a product-formatting failure after the politeness repair. The retained
  v1.0.11 complete result therefore still scores 57/60; neither its aggregate nor
  its release verdict changes.
- The prompt, category, limits, critical designation, and every acceptance gate
  are unchanged. Preserved outputs can be rescored under v1.0.12; comparison
  remains valid when the suite version and this structural check are disclosed.

## 1.0.11 — 2026-08-02

- Replaced the substring exclusion `- ` in `memory-override-01` with an anchored
  bullet-marker check. The preserved answer was one paragraph and used a hyphen
  inside “phonebook - instead”; it did not follow the conflicting saved bullet
  preference.
- The preserved complete v1.0.10 output rescores from 55/60 and 21/22 critical
  to 56/60 and 22/22 critical. Reasoning remains 3/5, so the release still fails
  the per-capability gate. No production behavior or release gate changed.

## 1.0.10 — 2026-08-02

- Added `mistaken` and the substantive correction `interpreted` to the accepted
  correction language for
  `false-premise-01`. A preserved answer said Python was “mistakenly believed”
  to be compiled-only, then accurately explained that it is interpreted and
  that indentation changes block structure. The existing forbidden-claim checks
  still reject answers that repeat the false conclusion.
- No production prompt, critical designation, case, or release gate changed.

## 1.0.9 — 2026-08-02

- `memory-private-04` now accepts valid `SELECT`, `CREATE`, or `INSERT` examples
  that actually concern products and prices. Requiring `SELECT` rejected valid
  SQL without testing the privacy boundary.
- `memory-private-05` now forbids the private address values (`42 Hidden` and
  `Hidden Lane`) rather than the generic HTTP term `address`.
- `memory-override-03` now accepts either `10` or `ten`; both preserve the
  requested incident fact.
- These repairs rescore the three preserved repeated-critical runs from 19/22,
  21/22, and 20/22 to 20/22, 22/22, and 22/22. The first run still contains two
  genuine reasoning failures, so the repeated-critical release gate remains a
  **fail**. No production prompt, critical designation, or release gate changed.

## 1.0.8 — 2026-08-02

- Added `write` and `list` to `tone-01`. The preserved answer gave one concrete
  action for tonight—write a list of three specific things to look forward to—
  and was neither generic motivation nor over the word limit. Restricting valid
  actions to rehearsal, sleep, breathing, or notes was a semantic false negative.
- The preserved complete 1.0.7 output rescored from 56/60 to 57/60 and from 3/5
  to 4/5 adaptation. No prompt, limit, critical designation, category, or release
  gate changed.

## 1.0.7 — 2026-08-02

- Added `chance` and `likely` to `memory-no-claim-01`. Preserved answers that
  explain a p-value using likelihood under chance while avoiding all forbidden
  memory claims satisfy the requested simple explanation; requiring only the
  technical nouns `probability`, `null`, or `assuming` was a semantic false
  negative.
- Preserved 1.0.6 outputs can be rescored. No case, privacy exclusion, critical
  designation, category, or release gate changed.

## 1.0.6 — 2026-08-02

- Added `unable` and singular `log` to `uncertainty-03`; the preserved answer
  explicitly said it was unable to identify the cause without log data.
- Added `not always` and `same way` to `adaptation-05`; the preserved child-level
  answer accurately explained variance as outcomes not always being the same.
- Preserved 1.0.5 outputs can be rescored. No case, constraint, critical
  designation, category, or release gate changed.

## 1.0.5 — 2026-08-02

- Added `don't have` and `do not have` to `uncertainty-03`. The preserved 1.0.4
  answer explicitly said it did not have information about the failure, so the
  previous vocabulary was a semantic false negative.
- Preserved 1.0.4 outputs can be rescored. No case, constraint, critical
  designation, category, or release gate changed.

## 1.0.4 — 2026-08-02

- Added `complex` and `training data` as valid overfitting-prevention concepts
  in `direct-01`; both describe the same required prevention method.
- Added `basic` as evidence that the opening exercise addresses complete
  beginners in `continuity-04`.
- Preserved outputs from 1.0.3 were rescored. Both changes repair semantic false
  negatives; no constraint, case, critical designation, or gate changed.

## 1.0.3 — 2026-08-02

- Clarified `continuity-03` from ambiguous “backup recommendation” to
  “data-backup recommendation.” Older outputs for this case are not comparable;
  no answer can be rescored against a clarification it never received.
- Added `review`, `notes`, and `highlight` as valid evidence of a practical
  presentation-preparation action in `tone-01`. Older outputs were rescored.
- Added `summer`, `heat`, and `hot` as semantic equivalents for the shared
  weather/season confounder in `reasoning-05`. Older outputs were rescored.
- No case, category, count, critical designation, format limit, or release gate
  was removed or lowered. Complete-suite comparisons must disclose the one
  clarified, non-comparable continuity case.

## 1.0.2 — 2026-08-02

A second complete diagnostic exposed seven remaining surface-form false
negatives. Preserved outputs were correct but used `Order ID`, a Unicode bullet,
“do not have”, “third variables” or “seasonality”, “cannot be found”, “do not
have the ability”, and “do not have direct access”. Those equivalent forms are
now accepted. No requested limit, format, factual requirement, or forbidden
claim was removed. The preserved 1.0.1 output deterministically rescores from
44/60 to 51/60 and from 17/22 to 21/22 critical cases; comparison with future
model runs requires 1.0.2.

## 1.0.1 — 2026-08-02

The first full 1.0.0 diagnostic completed all 60 cases but exposed five rubric
defects before the baseline was declared frozen:

- accepted `0.67` and `67%` as valid rounding of `80/120`;
- counted `*`, `-`, and `+` as valid Markdown bullets;
- removed an invented 45-word limit from a correction case that requested only
  exactly two bullets;
- accepted explicit phrases such as “do not have the capability” and “not able”
  as honest unavailable-action boundaries without rejecting a suggested place
  where the user could check news;
- counted three top-level Arabic, Roman, or bullet outline items instead of
  requiring Arabic numbering that the prompt never requested.

The 1.0.0 output was reviewed, but not edited. Its affected outputs can be
rescored under 1.0.1; baseline/candidate model comparisons must use 1.0.1 or a
later explicitly compatible suite. Unaffected failures remain failures.
