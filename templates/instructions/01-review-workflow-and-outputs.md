# Review workflow and outputs

## Review goal

Review the MR/PR changes and write structured review outputs.

Do not modify source files directly. Only write files under `.revkit/outputs/`.

If you accidentally modify any other file, stop and report the accidental modification in your final response. Do not attempt broad cleanup commands.

Your role is to produce comments, findings, summaries, and review notes. The developer decides what to apply or publish.

## Execution model: read-only review, no local validation commands

This workspace is for code review and output generation, not for local validation.

Do not run commands that execute, build, test, lint, format, package, migrate, start, or otherwise validate the project locally.

Do not run commands such as:

- `mvn test`, `mvn verify`, `gradle test`, `npm test`, `npm run build`, `yarn test`
- linters, formatters, type checkers, package managers, database migrations, Docker Compose, application startup commands, or Git hooks
- dependency installation or update commands

The project pipeline is responsible for compile, test, lint, format, packaging, security scans, and other mechanical validation. If the pipeline is red, developers can see that in the MR/PR.

Review tests by reading the diff and existing test files. You may flag missing, weak, or misleading tests when there is a concrete risk, but do not execute tests yourself and do not claim that tests pass unless that information is explicitly present in the MR/PR context.

Allowed local activity is limited to reading and searching files needed for review, such as inspecting source files, diff artifacts, thread files, and existing documentation.

## Required output files

Always write all expected output files under `.revkit/outputs/`.

Use `[]` for empty JSON outputs.

Required files:

| File                                | Purpose                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `.revkit/outputs/replies.json`      | Replies to existing MR/PR threads                                              |
| `.revkit/outputs/new-findings.json` | New positional review findings to post as threads                              |
| `.revkit/outputs/summary.md`        | **Changelog-style description of what the MR/PR changes** — not what you found |
| `.revkit/outputs/review.md`         | Optional public review body for the current publish operation; may be empty    |

If there are no review notes worth publishing, leave the file empty. Do not write filler such as "No new findings", "Nothing to report", or "Reviewed without comments".

Do not omit output files.

## Language and encoding

### Reply language

Match the language of the thread you are replying to.

If the thread comments are in German, reply in German. If in English, reply in English. If mixed, prefer the language of the most recent human comment.

Do not switch languages within a single reply.

### UTF-8 encoding

All output files are read and written as UTF-8. Use proper Unicode characters — including umlauts (ä, ö, ü, ß), accented characters, and other non-ASCII text.

Do not omit, escape, or transliterate special characters. For example, write "Änderung" not "Aenderung".

## Output validation

revkit may mechanically validate required files, JSON syntax, output schemas, and positional anchors before publishing.

Your job is to write the required output files correctly. Do not spend extra tool calls re-validating conditions that revkit can check deterministically.

## Input files

Follow the reading order from `.revkit/CONTEXT.md`. For narrowed refresh tasks, follow the task mode from `CONTEXT.md`.

Key diff artifacts:

- `.revkit/diffs/files.json` — changed-file index
- `.revkit/diffs/latest.patch` — full unified diff
- `.revkit/diffs/patches/by-file/` — per-file diffs for focused review
- `.revkit/diffs/line-map.ndjson` — positional review anchors
- `.revkit/diffs/change-blocks.json` — larger insert/delete/replace relationships

Use checked-out source files to understand the current MR/PR state when the diff alone is not enough.

`REVIEW.md` is the project-specific review policy. Use it for project priorities, terminology, conventions, known false positives, testing expectations, and security expectations.

---
