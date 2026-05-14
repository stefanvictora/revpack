# Review instructions index

This file is the router for detailed task-specific instruction files. It does not contain the full review rules.

Read `.revpack/CONTEXT.md` first — it has the MR/PR metadata, changed files, threads, and the **Required Instructions for This Run** section that tells you exactly which files to read.

Read `.revpack/AGENT_CONTRACT.md` next — it contains the short mandatory review contract.

Then read the instruction files listed in CONTEXT.md.

## Instruction files

| File                                   | When to read             | Purpose                                                                      |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `01-review-workflow-and-outputs.md`    | Always                   | Review goal, execution model, required outputs, validation, input-file order |
| `02-thread-replies.md`                 | Unresolved threads exist | Deciding whether to reply, writing `outputs/replies.json`                    |
| `03-new-findings-and-anchors.md`       | Always                   | Quality bar, diff navigation, positional anchors, severity, categories       |
| `04-suggestions-and-agent-handover.md` | Always                   | Suggestion blocks and handover prompts for fixing agents                     |
| `05-review-note.md`                    | Always                   | Optional MR/PR-level `outputs/review.md` synthesis                           |
| `06-summary.md`                        | Always                   | Changelog-style `outputs/summary.md`                                         |
| `07-final-checks.md`                   | Always                   | Lightweight final self-check                                                 |

All instruction files are in `.revpack/instructions/`.

## Output routing

| Output file                 | Contains                                                      |
| --------------------------- | ------------------------------------------------------------- |
| `outputs/new-findings.json` | Concrete, actionable positional issues                        |
| `outputs/replies.json`      | Useful replies to existing unresolved threads                 |
| `outputs/summary.md`        | What the MR/PR changes (changelog-style)                      |
| `outputs/review.md`         | Optional MR/PR-level synthesis; leave empty if nothing useful |

Only write files under `.revpack/outputs/`. Do not modify source files.
