---
agent: agent
description: "Full code review: address threads, find issues, suggest fixes"
---

# Code Review

A review workspace has been prepared in `.revkit/`.

Your role is to review and provide feedback. Do **not** modify source files directly.

## Read first

1. `.revkit/CONTEXT.md` — MR-specific metadata, changed files, existing threads, previous actions, and output locations.
2. `.revkit/INSTRUCTIONS.md` — stable review workflow, output schemas, finding quality bar, positional anchor rules, and formatting rules.
3. `REVIEW.md`, if present — project-specific review priorities and conventions.

## Work to perform

1. Address existing review threads where a reply is useful.
2. Review the changed behavior for additional concrete issues.
3. Write all required output files.
4. Present a concise summary table to the developer.

## Non-negotiables

- Do **not** modify source files.
- Use `.revkit/diffs/line-map.json` as the source of truth for positional finding anchors.
- Prefer fewer, high-confidence findings over many speculative findings.
- Do not duplicate existing unresolved threads or previous actions.
- Always write:
    - `outputs/replies.json`
    - `outputs/new-findings.json`
    - `outputs/summary.md`
    - `outputs/review.md`
- Use `[]` for empty JSON outputs.
- Do not publish anything unless the developer explicitly asks you to publish.

Follow `.revkit/INSTRUCTIONS.md` for all schemas, formatting rules, quality rules, and GitLab positional anchor rules.
