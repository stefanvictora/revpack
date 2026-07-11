# Review Context

## Target

| Field         | Value                    |
| ------------- | ------------------------ |
| Type          | GitHub pull request      |
| PR            | #42 - Add invoice export |
| Repository    | `acme/billing-app`       |
| Author        | @dev                     |
| Source branch | `invoice-export`         |
| Target branch | `main`                   |
| State         | open                     |

This file is the run-specific entry point.

1. Read the **Review Contract** below.
2. Read the files listed in **Required Instructions for This Run**.

Use `.revpack/INSTRUCTIONS.md` only as a catalog when you need to inspect the full instruction set.

## Review Contract

1. Do not modify source files directly.
2. Only write files under `.revpack/outputs/`.
3. Create output files only when you have draft material for them.
4. Write `.revpack/outputs/summary.md` for fresh and incremental code review runs.
5. Omit `replies.json`, `new-findings.json`, and `review.md` when there is nothing useful for them.
6. Do not write filler such as "No new findings", "Nothing to report", "Reviewed without comments", or "Looks good".
7. Do not run build, test, lint, format, package-manager, migration, Docker, application-startup, Git-hook, publishing, or repository-audit commands.
8. Use patch files to understand the code change.
9. Use the per-file Anchor Maps listed in `.revpack/diffs/files.json` as the source of truth for positional anchors.
10. Do not derive old or new line numbers from the checked-out workspace or by manually counting patch lines.
11. Create new findings only for concrete, actionable issues introduced, exposed, or made worse by the MR/PR.
12. In incremental mode, focus review effort on the checkpoint delta, but do not discard a valid, non-duplicate issue introduced, exposed, or made worse by the current MR/PR merely because it is outside the checkpoint delta.
13. Do not duplicate existing unresolved threads, previous actions, or other new findings.
14. Put concrete line-level issues in `new-findings.json`, not in `review.md`.
15. Put useful replies to existing threads in `replies.json`; otherwise omit the file.
16. Resolve only threads created by revpack itself (`SELF` threads).
17. `summary.md` describes what the MR/PR changes, not what the reviewer found.
18. `review.md` is optional MR/PR-level synthesis, not a second findings file or review report.
19. Do not reference internal bundle files such as `.revpack/`, `CONTEXT.md`, `threads/`, `outputs/`, `latest.patch`, or `anchor-maps/` in public output.
20. If you accidentally modify files outside `.revpack/outputs/`, stop and report it in your final response. Do not attempt broad cleanup commands.

## Current Run Mode

| Field        | Value                                                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| Mode         | Fresh review                                                                        |
| Primary work | Review the MR/PR changes, address unresolved threads, and write the review outputs. |

## Required Instructions for This Run

1. `.revpack/instructions/01-review-workflow-and-outputs.md`
2. `.revpack/instructions/02-thread-replies.md`
3. `.revpack/instructions/03-new-findings-and-anchors.md`
4. `.revpack/instructions/04-suggestions-and-agent-handover.md`
5. `.revpack/instructions/05-review-note.md`
6. `.revpack/instructions/06-summary.md`
7. `.revpack/instructions/07-final-checks.md`

## Bundle Contents

| Path                          | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `.revpack/threads/`           | unresolved review threads                                   |
| `.revpack/diffs/latest.patch` | canonical full unified diff                                 |
| `.revpack/diffs/files.json`   | changed-file index with per-file patch and Anchor Map paths |
| `.revpack/diffs/anchor-maps/` | compact per-file maps of valid positional review anchors    |
| `.revpack/outputs/`           | agent output files                                          |

## Unresolved Threads

| Thread | Flags | Author      | Location           | Summary                                             |
| ------ | ----- | ----------- | ------------------ | --------------------------------------------------- |
| T-001  | SELF  | @review-bot | `src/export.ts`:88 | Existing export error path still needs confirmation |
