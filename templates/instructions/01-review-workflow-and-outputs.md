# Review workflow and outputs

## Execution model

Read and search the diff, source, tests, review threads and documentation relevant to the task. Write drafts only under `.revpack/outputs/`. The developer decides what to apply or publish.

Leave test execution and other mechanical checks to the project pipeline. Describe the assertions you read without claiming the tests passed. Flag a gap when you can name the regression it would miss.

## Output files

Create output files only when you have draft material for them. Missing `replies.json`, `new-findings.json`, and `note.md` means there is nothing to publish for that output.

Write `summary.md` for fresh and incremental code review runs. Do not write filler content to any output file.

| File                        | When to write it                                                           |
| --------------------------- | -------------------------------------------------------------------------- |
| `outputs/replies.json`      | Useful replies to existing MR/PR threads                                   |
| `outputs/new-findings.json` | New positional review findings                                             |
| `outputs/summary.md`        | Changelog-style description of what the MR/PR changes — not what you found |
| `outputs/note.md`           | Useful optional MR/PR-level synthesis                                      |

## Rerunning a review

Treat a bundle as single-writer: do not run multiple review agents against the same bundle at the same time.

Existing `replies.json`, `new-findings.json`, and `note.md` are pending, revisable drafts. Read and reconcile them before finishing a rerun: retain still-valid material, revise or remove stale material, deduplicate additions, and delete a conditional output file when nothing remains. Do not assume existing content was already published; successful publishing removes consumed drafts.

When reconciling an existing `replies.json`, a referenced `T-NNN` thread may be in `.revpack/threads/` or `.revpack/resolved-threads/`. A thread's current resolved state does not by itself invalidate a pending draft reply; retain, revise, or remove the draft based on whether it remains useful.

Read an existing `summary.md` before updating it.

## Language and encoding

- **Default to English** for new findings, summaries, and the review note. Use a different language only when the MR/PR title, description, and thread comments are predominantly in that language.
- **Match the thread language** when replying. If a thread is in German, reply in German. If mixed, prefer the language of the most recent human comment.
- All output is UTF-8. Use proper Unicode (e.g. "Änderung", not "Aenderung").

## Output validation

Use the read-only schema references at `schemas/replies.schema.json` and `schemas/new-findings.schema.json` when authoring their corresponding JSON outputs. Revpack independently validates output files, JSON syntax, schemas, and positional anchors before publishing. Use the required lookup steps in the finding instructions to choose anchors, but do not spend extra tool calls re-checking what revpack can verify mechanically.

## Input files

Follow the reading order from `.revpack/CONTEXT.md`.

Key diff artifacts:

| Artifact                 | Purpose                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `diffs/files.json`       | Changed-file index — use for navigation and authoritative per-file artifact paths                          |
| `diffs/latest.patch`     | Full unified diff — use for overall MR/PR understanding                                                    |
| `diffs/patches/by-file/` | Per-file diffs — read paths selected from `diffs/files.json`                                               |
| `diffs/anchor-maps/`     | Per-file valid positional anchors — read exact paths from `diffs/files.json` or search the whole directory |

Use checked-out source files when the diff alone is not enough.

---
