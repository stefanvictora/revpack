# Review workflow and outputs

## Review goal

Review the MR/PR changes and write structured review outputs under `.revkit/outputs/`. Do not modify source files. The developer decides what to apply or publish.

If you accidentally modify files outside `.revkit/outputs/`, stop and report it immediately.

## Execution model

This workspace is read-only — for code review and output generation, not local validation.

Do not run build, test, lint, format, package-manager, migration, Docker, startup, or Git-hook commands. The project pipeline handles mechanical validation; if it fails, developers can see that in the MR/PR.

Review tests by reading the diff and existing test files. Flag missing or misleading tests when there is a concrete risk, but do not execute them or claim they pass.

Allowed activity: reading and searching files needed for review (source files, diff artifacts, thread files, documentation).

## Required output files

Always write all four output files. Use `[]` for empty JSON outputs. Leave `review.md` empty (not filler) when there is no useful MR/PR-level note.

| File | Purpose |
|---|---|
| `outputs/replies.json` | Replies to existing MR/PR threads |
| `outputs/new-findings.json` | New positional review findings |
| `outputs/summary.md` | Changelog-style description of what the MR/PR changes — not what you found |
| `outputs/review.md` | Optional MR/PR-level synthesis; may be empty |

## Language and encoding

- **Default to English** for new findings, summaries, and the review note. Use a different language only when the MR/PR title, description, and thread comments are predominantly in that language.
- **Match the thread language** when replying. If a thread is in German, reply in German. If mixed, prefer the language of the most recent human comment.
- All output is UTF-8. Use proper Unicode (e.g. "Änderung", not "Aenderung").

## Output validation

revkit validates output files, JSON syntax, schemas, and positional anchors before publishing. Do not spend extra tool calls re-checking what revkit can verify mechanically.

## Input files

Follow the reading order from `.revkit/CONTEXT.md`.

Key diff artifacts:

| Artifact | Purpose |
|---|---|
| `diffs/files.json` | Changed-file index — use for navigation and file selection |
| `diffs/latest.patch` | Full unified diff — use for overall MR/PR understanding |
| `diffs/patches/by-file/` | Per-file diffs — use for focused review of individual files |
| `diffs/line-map.ndjson` | Valid positional anchors — every finding must reference a line here |
| `diffs/change-blocks.json` | Grouped insert/delete/replace blocks |

Use checked-out source files when the diff alone is not enough.

`REVIEW.md` in the repository root contains project-specific review priorities and conventions.

---
