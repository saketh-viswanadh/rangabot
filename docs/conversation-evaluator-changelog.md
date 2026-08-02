# Conversation evaluator changelog

Rubric changes are versioned separately from production behavior. A rubric
repair must explain its effect on comparability; it must never conceal a real
model or orchestration failure.

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
