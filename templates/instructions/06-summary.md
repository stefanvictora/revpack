# MR/PR summary

## `outputs/summary.md`

**This file describes what the MR/PR changes — not what the reviewer found.**

Do not write a summary of your review activities, findings, or review status here. That belongs in `review.md`.

`.revkit/outputs/summary.md` is a human-readable changelog entry for the MR/PR. It will be published to the MR/PR description so other developers can understand what changed without reading the diff.

Write a concise, changelog-style summary for humans. The summary should be curated, not a file list, commit list, or code walkthrough.

Use Markdown headings for change categories.

Only include categories that have content.

Do not include a version heading, date, or `Unreleased` heading. This file describes one MR/PR, not a full release changelog.

Allowed categories, in preferred order:

```md
## Added

- ...

## Changed

- ...

## Deprecated

- ...

## Removed

- ...

## Fixed

- ...

## Security

- ...

## Performance

- ...

## Tests

- ...

## Documentation

- ...

## Internal

- ...
```

Category meanings:

- **Added** — new user-facing, API-visible, or operational capabilities.
- **Changed** — changes to existing behavior, workflows, APIs, configuration, logging, validation, or internal processing.
- **Deprecated** — functionality, APIs, options, fields, or behavior that still exists but is now discouraged and planned for removal or replacement.
- **Removed** — functionality, APIs, options, fields, files, or behavior that was removed.
- **Fixed** — corrections for incorrect behavior, regressions, broken edge cases, crashes, or production issues.
- **Security** — security-related fixes or hardening, including authorization, authentication, injection risks, secrets, sensitive data, or audit-relevant behavior.
- **Performance** — measurable or intentional performance, scalability, memory, query, concurrency, or resource-usage improvements.
- **Tests** — added or changed automated tests, test fixtures, or test infrastructure.
- **Documentation** — documentation, comments intended as docs, examples, or user/developer guidance.
- **Internal** — refactoring, cleanup, dependencies, build, CI, formatting, configuration, or other maintenance changes without direct behavior impact.

If a change could fit multiple categories, choose the category that is most useful to someone reading the MR/PR description.

Prefer user- or domain-facing categories over internal ones:

- Use **Added**, **Changed**, **Fixed**, **Security**, or **Performance** when the change affects behavior.
- Use **Tests**, **Documentation**, or **Internal** when the change mainly supports development or maintenance.

Write for someone who has not read the diff.

Each bullet should answer:

> What changed in the application or codebase?

Good examples:

```md
## Changed

- Simplifies mass-registration submission handling by moving repeated validation into the service layer.
- Improves error handling when asynchronous DMS persistence fails.

## Fixed

- Corrects selectable-year calculation for mass-registration requests with boundary-year data.

## Tests

- Adds regression coverage for selectable-year calculation in mass-registration requests.
```

Avoid weak or implementation-only bullets like:

```md
- Changed `MassRegistrationController.java`.
- Updated some service logic.
- Refactored code.
```

Rules:

- Describe what the developer changed, not what the reviewer found.
- Do not include review findings, suspected bugs, risks, approval status, or quality judgments.
- Do not include unresolved thread information.
- Do not mention internal bundle files such as `.revkit/`, `CONTEXT.md`, `outputs/`, `latest.patch`, or `line-map.ndjson`.
- Do not include a file list.
- Do not write a code walkthrough.
- Do not include empty categories.
- Keep it concise: one bullet per meaningful change.
- Merge tiny related changes into one bullet.
- Use present tense, for example “Adds”, “Changes”, “Deprecates”, “Removes”, “Fixes”, “Improves”, “Updates”.
- Use the project’s own terminology when visible in the code, MR/PR description, or `REVIEW.md`.
- Prefer plain language over implementation jargon unless the implementation detail is the important change.

If the diff is too ambiguous to determine user-facing behavior, summarize the safest observable codebase-level change.

Example:

```md
## Internal

- Refactors mass-registration service logic without changing the public API.
```

Do not invent intent that is not visible from the diff or MR/PR context.

---
