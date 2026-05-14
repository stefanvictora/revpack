---
agent: agent
description: 'Full code review: address threads, find issues, suggest fixes'
---

# Code Review

A review workspace has been prepared in `.revpack/`.

Your role is to review the MR/PR and write structured review outputs. Do **not** modify source files or project files outside `.revpack/outputs/`.

## Read first

1. `.revpack/CONTEXT.md` — MR/PR-specific metadata, bundle contents, changed files, existing threads, and the **Required Instructions for This Run**.
2. `.revpack/AGENT_CONTRACT.md` — short mandatory review contract.
3. `.revpack/INSTRUCTIONS.md` — index for task-specific instruction files.
4. The instruction files listed in CONTEXT.md under **Required Instructions for This Run**.
5. `REVIEW.md`, if present — project-specific review priorities and conventions.

## Work to perform

1. Re-check existing unresolved review threads against the current code and diff.
2. Reply to existing threads only when a reply is useful according to the thread-replies instructions.
3. Mark own revpack-created threads for resolution when the issue is fixed.
4. Review the changed behavior for additional concrete issues.
5. Write all required output files.
6. Present a concise summary table to the developer.

## Critical rules

- Do **not** modify source files.
- Do **not** publish anything unless the developer explicitly asks you to publish.
- Prefer fewer, high-confidence findings over many speculative findings.
- Do not duplicate existing unresolved threads.
- Use patch files to understand the code change.
- Use `.revpack/diffs/line-map.ndjson` as the source of truth for positional finding anchors.
- Do not calculate old or new line numbers manually from patches or checked-out files.
- Always write or update:
  - `.revpack/outputs/replies.json`
  - `.revpack/outputs/new-findings.json`
  - `.revpack/outputs/summary.md`
  - `.revpack/outputs/review.md`
- Use `[]` for empty JSON outputs.

For all details, follow the instruction files listed in `.revpack/CONTEXT.md`. If this prompt and the instruction files disagree, the instruction files win.
