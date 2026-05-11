# MR/PR-level review note

`outputs/review.md` is for MR/PR-level synthesis. Default to leaving it empty.

## When to write it

Write `review.md` only when you have a concrete concern, confirmation question, or cross-cutting pattern that helps the author or reviewers decide whether the change is ready to merge. It must fit in 1–3 short paragraphs.

Good uses:

- end-to-end feature, workflow, API, or migration that appears incomplete
- cross-file inconsistencies in authorization, validation, audit, or data-access policy
- rollout, migration, compatibility, backfill, or deployment concerns
- multiple inline findings sharing one broader root cause
- lower-confidence concerns that deserve human attention but are not proven enough for a positional finding
- risks not cleanly anchorable to one changed line
- repeated patterns (naming, structure, maintainability) across multiple changed files
- product, security, or architectural decisions that should be confirmed before merge

For lower-confidence concerns, phrase as a question: "Please confirm whether existing projects need a backfill for this counter."

## When to leave it empty

Leave it empty when all useful feedback is already in findings or thread replies, or when the only possible note would be filler ("looks good", "see inline comments"), a diff summary, a file list, or a speculative/theoretical concern.

## What it is not

It is not a second findings file, a review report, an audit log, or a place to duplicate line comments. Put concrete line-level issues in `new-findings.json`.

---
