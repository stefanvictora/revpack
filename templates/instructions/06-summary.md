# MR/PR summary

## `outputs/summary.md`

**This file describes what the MR/PR changes — not what the reviewer found.**

It is a human-readable changelog entry published to the MR/PR description so other developers can understand the change without reading the diff.

Write a concise, curated summary — not a file list, commit list, or code walkthrough. Use Markdown headings for categories. Only include categories that have content.

## Allowed categories (in preferred order)

```md
## Added

## Changed

## Deprecated

## Removed

## Fixed

## Security

## Performance

## Tests

## Documentation

## Internal
```

If a change fits multiple categories, choose the one most useful to a reader of the MR/PR description. Prefer user-facing categories (`Added`, `Changed`, `Fixed`, `Security`, `Performance`) over internal ones (`Tests`, `Documentation`, `Internal`).

**Internal** covers refactoring, cleanup, dependencies, build, CI, formatting, and configuration without direct behavior impact.

## Style rules

- Use present tense: "Adds", "Changes", "Fixes", "Improves".
- One bullet per meaningful change. Merge tiny related changes into one bullet.
- Use the project's own terminology when visible in the code or `REVIEW.md`.
- Prefer plain language over implementation jargon unless the implementation detail is the important change.
- Write for someone who has not read the diff.

<example>

```md
## Changed

- Simplifies mass-registration submission handling by moving repeated validation into the service layer.

## Fixed

- Corrects selectable-year calculation for mass-registration requests with boundary-year data.

## Tests

- Adds regression coverage for selectable-year calculation in mass-registration requests.
```

</example>

## Do not include

- Review findings, suspected bugs, risks, approval status, or quality judgments.
- Unresolved thread information or internal bundle file references.
- Version headings, dates, or `Unreleased` headings.
- File lists, empty categories, or code walkthroughs.
- Weak bullets like "Changed `Controller.java`" or "Refactored code".

If the diff is too ambiguous to determine user-facing behavior, summarize the safest observable codebase-level change.
