---
agent: agent
description: 'Generate an MR/PR description summary from the revkit bundle'
---

# MR/PR Summary Generation

A workspace bundle has been prepared in `.revkit/`.

Your task is to generate `.revkit/outputs/summary.md` for the MR/PR description.

Do not perform a code review.
Do not create findings, thread replies, or review notes.
Do not modify source files.
Do not publish anything unless the developer explicitly asks.

## Steps

1. Read `.revkit/CONTEXT.md`.
2. Read `.revkit/AGENT_CONTRACT.md`.
3. Read `.revkit/instructions/06-summary.md`.
4. Read `REVIEW.md` if present.
5. Read `.revkit/diffs/latest.patch`.
6. Use checked-out source files only when the diff alone is not enough to understand the changed behavior.
7. Write `.revkit/outputs/summary.md`.
8. Present the generated summary to the developer.

## Scope

In this mode, only produce the MR/PR summary.

Do not write or update:

- `.revkit/outputs/replies.json`
- `.revkit/outputs/new-findings.json`
- `.revkit/outputs/review.md`

Do not mention review findings, suspected issues, approval status, unresolved threads, or internal revkit files in the summary.

## Publishing

After the developer approves, they may run:

```bash
revkit publish description --from-summary
```

Do not run publishing commands unless explicitly asked.
