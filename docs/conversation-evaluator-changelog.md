# Conversation evaluator changelog

Rubric changes are versioned separately from production behavior. A rubric
repair must explain its effect on comparability; it must never conceal a real
model or orchestration failure.

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
