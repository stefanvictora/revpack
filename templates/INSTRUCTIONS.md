# Instruction catalog

This file is the catalog for detailed task-specific instruction files. It does not define the run-specific reading order.

Start from `.revpack/CONTEXT.md`. It is the run-specific entry point, contains the review contract, and its **Required Instructions for This Run** section is authoritative.

Use this index only when you need to understand what an instruction file covers or inspect the wider instruction set.

## Instruction files

| File                                   | Fresh review | Incremental code review | Thread follow-up | Outputs-only follow-up | Purpose                                                                      |
| -------------------------------------- | ------------ | ----------------------- | ---------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `01-review-workflow-and-outputs.md`    | Yes          | Yes                     | Yes              | Yes                    | Review goal, execution model, required outputs, validation, input-file order |
| `02-thread-replies.md`                 | If threads   | If threads              | Yes              | No                     | Deciding whether to reply, writing `outputs/replies.json`                    |
| `03-new-findings-and-anchors.md`       | Yes          | Yes                     | No               | No                     | Quality bar, diff navigation, positional anchors, severity, categories       |
| `04-suggestions-and-agent-handover.md` | Yes          | Yes                     | No               | No                     | Suggestion blocks and handover prompts for fixing agents                     |
| `05-review-note.md`                    | Yes          | Yes                     | No               | No                     | Optional MR/PR-level `outputs/note.md` synthesis                             |
| `06-summary.md`                        | Yes          | Yes                     | No               | No                     | Changelog-style `outputs/summary.md`                                         |
| `07-final-checks.md`                   | Yes          | Yes                     | Yes              | Yes                    | Lightweight final self-check                                                 |

All instruction files are in `.revpack/instructions/`.
