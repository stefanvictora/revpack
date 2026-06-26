# MR/PR summary

<hard_constraints>
Generate `outputs/summary.md`.

- Describe what the MR/PR changes, not what the reviewer found.
- Write for reviewers who have not read the diff yet.
- Use the smallest useful summary; small changes may need only one bullet.
- Most non-trivial MR/PRs should fit in 3–6 bullets total across all categories.
- Summarize reviewer-relevant outcomes, not implementation details.
- Do not duplicate the same change across multiple categories.
- Do not produce an exhaustive changelog, file list, commit list, or code walkthrough.
- Omit or merge any bullet that does not help explain scope, behavior, impact, or verification.

</hard_constraints>

## Purpose

`outputs/summary.md` is published to the MR/PR description so developers can quickly understand the intent, scope, and important behavior changes before reading the diff.

## Categories

Use only categories that have useful content.

Preferred order: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Performance`, `Tests`, `Documentation`, `Internal`

Prefer user-facing or behavior-facing categories over `Tests`, `Documentation`, and `Internal`.

Use `Internal` only when the internal change is important for understanding architecture, risk, migration, or future maintenance.

## Category selection

Use the category that best describes the reader-relevant effect of the change.

Choose categories relative to existing product behavior, not review timing. A capability newly introduced by this MR/PR is `Added` even if it appeared during an incremental review.

Use `Changed` for alterations to existing behavior, generated output, validation, workflows, or tool behavior.

Use `Documentation` for human-facing documentation such as README updates, guides, or explanatory text.

Avoid splitting the same change across multiple categories. Use multiple categories only when the MR/PR contains distinct kinds of changes.

## Include

Include bullets for:

- new capabilities or workflows
- changed behavior
- important fixes
- security or performance impact
- important documentation updates
- meaningful test coverage at the behavior/workflow level

Before writing a bullet, ask:

> Would this help a reviewer understand the scope, behavior, impact, or verification of the MR/PR?

If not, omit it or merge it into a broader bullet.

## Granularity

Summarize outcomes, not implementation parts.

Prefer this:

```md
- Adds local review mode for preparing and publishing feedback from a local Git workspace.
```

Not this:

```md
- Adds a local Git-backed provider, target display helpers, schema validation, and Git helper utilities.
```

Merge related changes aggressively:

- group helper/type/schema/refactor changes under the behavior they support
- group related fixes when they affect the same workflow
- group tests into one bullet unless separate test areas are independently important
- omit internal details that only explain how the change was built

## Style

- Use present tense: `Adds`, `Changes`, `Fixes`, `Improves`.
- Prefer plain language over implementation jargon.
- Use project terminology when visible in the code or `REVIEW.md`.
- Mention implementation details only when needed to understand behavior, impact, or maintainability.
- If behavior is ambiguous, summarize the safest observable codebase-level change.

## Do not include

- review findings, suspected bugs, approval status, or quality judgments
- speculative risks or open questions unless explicitly present in the existing MR/PR description, commit messages, or `REVIEW.md`
- unresolved thread information
- internal bundle file references
- version headings, dates, or `Unreleased` headings
- empty categories
- file-by-file summaries
- commit-by-commit summaries
- code walkthroughs
- separate bullets for helper functions, type definitions, schema changes, fallback branches, or individual test cases
- exhaustive test inventories
- motivation, testing instructions, or deployment steps unless explicitly present in the existing MR/PR description, commit messages, or `REVIEW.md`

<example>

```md
## Added

- Adds local review mode for preparing, reviewing, and publishing feedback from a local Git workspace before pushing.

## Changed

- Updates CLI output and target resolution to distinguish MR, PR, and local review targets more clearly.

## Tests

- Adds unit and integration coverage for local review workflows and related edge cases.
```

</example>
