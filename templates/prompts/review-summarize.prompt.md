---
agent: agent
description: "Generate an MR/PR description summary from the review-assist bundle"
---

# MR/PR Summary Generation

A workspace bundle has been prepared in `.review-assist/`.

Your task is to generate `.review-assist/outputs/summary.md` for the MR/PR description.

Do not perform a code review.
Do not create findings, thread replies, or review notes.
Do not modify source files.
Do not publish anything unless the developer explicitly asks.

## Steps

1. Read `.review-assist/CONTEXT.md`.
2. Read `.review-assist/INSTRUCTIONS.md`.
3. Read `REVIEW.md` if present.
4. Read `.review-assist/diffs/latest.patch`.
5. Use checked-out source files only when the diff alone is not enough to understand the changed behavior.
6. Write `.review-assist/outputs/summary.md`.
7. Present the generated summary to the developer.

Follow `.review-assist/INSTRUCTIONS.md` for the complete `outputs/summary.md` format, allowed categories, examples, and style rules.

## Scope

In this mode, only produce the MR/PR summary.

Do not write or update:

- `.review-assist/outputs/replies.json`
- `.review-assist/outputs/new-findings.json`
- `.review-assist/outputs/review-notes.md`

Do not mention review findings, suspected issues, approval status, unresolved threads, or internal review-assist files in the summary.

## Publishing

After the developer approves, they may run:

```bash
review-assist publish description --from-summary
```

Do not run publishing commands unless explicitly asked.
