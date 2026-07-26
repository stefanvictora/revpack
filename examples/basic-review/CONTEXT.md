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

This file is the neutral entry point for the prepared review bundle.

## Choose a task

### Use the bundle as context

Read only the artifacts relevant to the developer's task. The formal Review Contract does not apply. Fixing or addressing active threads also drafts useful replies in `.revpack/outputs/replies.json`.

### Perform a formal revpack review

Read `.revpack/instructions/00-review-contract.md`, then the required formal-review instructions below.

## Formal Review Run Mode

| Field        | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| Mode         | Fresh review                                                                           |
| Primary work | Review the MR/PR changes, address active review threads, and write the review outputs. |

## Required Formal Review Instructions for This Run

1. `.revpack/instructions/00-review-contract.md`
2. `.revpack/instructions/01-review-workflow-and-outputs.md`
3. `.revpack/instructions/02-thread-replies.md`
4. `.revpack/instructions/03-new-findings-and-anchors.md`
5. `.revpack/instructions/04-suggestions-and-agent-handover.md`
6. `.revpack/instructions/05-review-note.md`
7. `.revpack/instructions/06-summary.md`
8. `.revpack/instructions/07-final-checks.md`

## Bundle Contents

| Path                          | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `.revpack/threads/`           | active review threads                                       |
| `.revpack/diffs/latest.patch` | canonical full unified diff                                 |
| `.revpack/diffs/files.json`   | changed-file index with per-file patch and Anchor Map paths |
| `.revpack/diffs/anchor-maps/` | compact per-file maps of valid positional review anchors    |
| `.revpack/outputs/`           | agent output files                                          |

## Active Review Threads

| Thread | Flags | Author      | Location           | Summary                                             |
| ------ | ----- | ----------- | ------------------ | --------------------------------------------------- |
| T-001  | SELF  | @review-bot | `src/export.ts`:88 | Existing export error path still needs confirmation |
