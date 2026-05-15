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

1. Read `.revpack/AGENT_CONTRACT.md` next. It contains the short mandatory review contract.
2. Read the files listed in **Required Instructions for This Run**.

Use `.revpack/INSTRUCTIONS.md` only as a catalog when you need to inspect the full instruction set.

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

| Path                             | Description                     |
| -------------------------------- | ------------------------------- |
| `.revpack/threads/`              | unresolved review threads       |
| `.revpack/diffs/latest.patch`    | canonical full unified diff     |
| `.revpack/diffs/line-map.ndjson` | valid positional review anchors |
| `.revpack/outputs/`              | agent output files              |

## Unresolved Threads

| Thread | Flags | Author      | Location           | Summary                                             |
| ------ | ----- | ----------- | ------------------ | --------------------------------------------------- |
| T-001  | SELF  | @review-bot | `src/export.ts`:88 | Existing export error path still needs confirmation |
