# Review Instructions

Read `.review-assist/CONTEXT.md` first. It contains the MR/PR-specific metadata, changed files, existing threads, previous actions, and bundle layout.

These instructions are the stable contract for how an agent should review the prepared workspace bundle and write output files.

## Review goal

Review the MR/PR changes and write structured review outputs.

Do not modify source files directly. Your role is to produce comments, findings, summaries, and review notes. The developer decides what to apply or publish.

## Required output files

Always write all expected output files under `.review-assist/outputs/`.

Use `[]` for empty JSON outputs.

Required files:

- `.review-assist/outputs/replies.json`
- `.review-assist/outputs/new-findings.json`
- `.review-assist/outputs/summary.md`
- `.review-assist/outputs/review-notes.md`

If there are no review notes worth publishing, write an empty file or a short neutral note, depending on the existing tool convention.

Do not omit output files.

## Input files to read

Start with:

1. `.review-assist/CONTEXT.md`
2. `.review-assist/INSTRUCTIONS.md`
3. `REVIEW.md`, if present
4. `.review-assist/diffs/latest.patch`
5. `.review-assist/diffs/line-map.json`

Use checked-out source files to understand the current MR/PR state when the diff alone is not enough.

`REVIEW.md` is the project-specific review policy. Use it for project priorities, terminology, conventions, known false positives, testing expectations, and security expectations.

---

# Existing thread replies

Use `.review-assist/threads/` and the unresolved thread overview in `.review-assist/CONTEXT.md`.

Only write a reply when one of these is true:

- the thread asks a question
- you can confirm the issue is fixed
- you can provide a concrete suggestion
- you disagree and can explain why
- the thread is stale or no longer applies
- the thread needs a useful agent handover prompt for a non-trivial fix

Do not reply just to acknowledge a thread.

Skip threads marked **SELF** unless they have new follow-up from others or you are resolving your own previously published finding.

Skip threads marked **REPLIED** unless you have new information to add.

Set `"resolve": true` only for threads you created yourself (**SELF** threads). Do not resolve threads created by other reviewers.

## `outputs/replies.json`

Write replies to existing threads as a JSON array.

```json
[
  {
    "threadId": "T-001",
    "disposition": "suggest_fix",
    "body": "Good catch. The endpoint should preserve the existing audit call.\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\nVerify this issue against the current code and only fix it if still applicable.\n\nIn `@src/app.ts` around `exportData(...)`, restore the audit logging call before returning the export response. Add or update a regression test that verifies the audit service is called for successful exports.\n\n</details>",
    "resolve": false
  }
]
```

Required fields:

- `threadId`
- `body`
- `resolve`

Optional but recommended:

- `disposition`

Allowed dispositions:

- `already_fixed`
- `explain_only`
- `reply_only`
- `suggest_fix`
- `disagree`
- `escalate`

---

# New findings

Use `.review-assist/outputs/new-findings.json` only for concrete, actionable issues tied to a visible diff line.

Prefer fewer, higher-value findings over many speculative findings.

## Review quality bar

Create a new finding only when all of these are true:

1. The issue is introduced, exposed, or made worse by this MR/PR.
2. The issue is visible from the diff or directly caused by changed code.
3. The impact is concrete: incorrect behavior, security risk, data loss, broken API contract, performance regression, missing test for risky behavior, or maintainability problem with real risk.
4. The finding can be explained in 1-3 concise paragraphs.
5. The finding is not already covered by an existing thread, previous action, or another new finding.

Do not create findings for:

- speculative issues
- broad refactoring preferences
- style opinions unless they affect readability or consistency in changed code
- unrelated pre-existing problems
- code outside the diff unless directly affected by this MR/PR
- theoretical performance issues without evidence of impact

## Review changed behavior, not just changed lines

When reviewing a changed line, also inspect the surrounding method, class, component, or direct call path if needed.

Ask:

- What behavior changed?
- What inputs can reach this code?
- What happens on null, empty, invalid, duplicate, unauthorized, or failed external calls?
- Does this change preserve existing API, database, security, audit, or compatibility behavior?
- Are existing tests still meaningful, or did the change bypass them?

Do not limit your reasoning to the added lines, but only create positional findings on lines listed in `.review-assist/diffs/line-map.json`.

## `outputs/new-findings.json`

Write new findings as a JSON array.

```json
[
  {
    "oldPath": "src/app.ts",
    "newPath": "src/app.ts",
    "newLine": 42,
    "body": "**Potential null dereference**: `user.name` is accessed without a null check.\n\nThe changed code now reads `user.name` before validating that `user` exists. If the API receives a request without a resolved user, this will fail with a runtime error instead of returning the expected validation response.\n\nSuggested fix: guard the access or return the existing unauthorized/validation response before reading the property.\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\nVerify this issue against the current code and only fix it if still applicable.\n\nIn `@src/app.ts` around line 42, add a guard before accessing `user.name`. Preserve the existing response behavior for missing users and add or update a regression test for a request without a resolved user.\n\n</details>",
    "severity": "high",
    "category": "correctness"
  }
]
```

Required fields:

- `oldPath`
- `newPath`
- `body`
- `severity`
- `category`
- at least one of `oldLine` or `newLine`

For non-renamed files, `oldPath` and `newPath` are usually identical.

## Positional anchors

Use `.review-assist/diffs/line-map.json` as the source of truth for valid positional anchors.

Do not calculate `oldLine` or `newLine` manually from the patch. Use `diffs/latest.patch` to understand the diff, not to derive line numbers.

Each finding location must exactly match one line-map entry:

- `type: "added"` → use `newLine` only
- `type: "removed"` → use `oldLine` only
- `type: "context"` → use both `oldLine` and `newLine`

Do not anchor a finding to a line that is not present in `.review-assist/diffs/line-map.json`.

Prefer findings on added lines. They are usually the clearest anchors for issues introduced by the MR/PR.

Use removed-line findings only for harmful deletions.

Use context-line findings only when the context line is visible in the line map and is the clearest stable anchor.

A line that exists only in the checked-out source file but is not listed in `line-map.json` is not valid for a positional finding.

## Duplicate finding avoidance

Before creating a new finding, check:

1. Existing unresolved threads.
2. Previous Actions in `.review-assist/CONTEXT.md`.
3. Other new findings you are about to write.

Treat a finding as duplicate if it has the same root cause, even if it appears on a nearby line.

If one root cause affects multiple nearby lines, create one finding at the clearest changed line.

If the same root cause appears in multiple files, create one finding only if a single fix location is obvious. Otherwise, create separate findings only when each location needs a different fix.

## Finding body format

Use this structure when applicable:

````md
**Short issue title**: Explain the concrete problem and why it matters.

The changed code does X, but in condition Y this causes Z. This is likely to affect [user/API/data/security/runtime behavior].

Suggested fix: [brief fix direction].

```suggestion:-0+0
direct local replacement, if safely applicable
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

Verify this issue against the current code and only fix it if still applicable.

In `@path/to/File.java` around `methodName(...)`, [describe the full fix and any tests].

</details>
````

Omit the suggestion block only when the local replacement is not safe or complete.
Omit the handover prompt only when the fix is trivial and the suggestion block is sufficient.

Keep findings concise. Do not include long code walkthroughs.

## Severity guide

Choose severity based on concrete impact, not on how suspicious the code looks.

Allowed severities:

- `blocker` — breaks core functionality, causes data loss, or creates a serious security issue
- `high` — likely production bug, security issue, broken API contract, or serious regression
- `medium` — realistic edge case or maintainability issue that can cause future bugs
- `low` — minor risk or small robustness improvement
- `nit` — cosmetic or naming issue; use rarely

If you cannot explain the concrete impact, do not use `high` or `blocker`.

## Allowed categories

Use only these category values:

- `security`
- `correctness`
- `performance`
- `testing`
- `architecture`
- `style`
- `documentation`
- `naming`
- `error-handling`
- `general`

Do not invent additional severity or category values.

---

# Suggestions and agent handover prompts

## GitLab suggestion blocks

Prefer including a GitLab suggestion block when the core fix is a small, directly applicable change to lines visible in the diff.

Use a suggestion block when all of these are true:

- the replacement is complete for the local changed lines
- the changed lines are visible in `.review-assist/diffs/line-map.json`
- the suggestion is likely to compile
- the suggestion does not require unrelated edits in the same block
- the suggestion is easier for the developer to apply than rewriting the code manually

A fix may still need tests, imports, or follow-up changes elsewhere. That does not automatically disqualify a suggestion block.

If the main code fix is local but additional work is needed, include both:

1. a GitLab suggestion block for the directly applicable local code change
2. an agent handover prompt describing the remaining work, such as tests or related updates

Do not use suggestion blocks for:

- pseudocode
- incomplete fragments
- changes where the shown replacement alone would clearly not compile
- large rewrites
- changes requiring edits in multiple unrelated locations where a single local suggestion would be misleading
- fixes you are not confident about

For most findings, use:

````markdown
```suggestion:-0+0
replacement for the anchored line
```
````

Use wider ranges only when the replacement really needs neighboring lines.

## Positional anchor vs suggestion range

Do not confuse the finding anchor with the GitLab suggestion block range.

The finding anchor chooses where the GitLab thread appears:

```json
{
  "newLine": 42
}
```

The suggestion block range chooses which lines around that anchor are replaced:

````markdown
```suggestion:-1+2
replacement code
```
````

The suggestion offsets are relative to the anchored line.

## Agent handover prompts

Agent handover prompts are complementary to GitLab suggestion blocks.

Include an agent handover prompt when the fix is clear and a developer may want an AI coding agent to implement the full change.

Use a handover prompt especially for:

- findings that require edits in multiple places
- fixes that require adding or updating tests
- fixes that may need imports, method signature changes, or refactoring
- replies where an existing thread asks for a change and the fix is more than a small one-line suggestion
- cases where a suggestion block would be too large or fragile

If a small local code suggestion is possible, include it even when you also include a handover prompt.

Good pattern:

1. Explain the issue.
2. Provide a small suggestion block for the direct local fix.
3. Add a handover prompt for tests, imports, related changes, or broader cleanup.

Use this format:

```md
<details>
<summary>🤖 Prompt for AI Agents</summary>

Verify this issue against the current code and only fix it if still applicable.

In `@src/path/to/File.java` around `methodName(...)`, replace the current behavior that ... with ...
Also update or add tests covering ...

</details>
```

Rules:

- Reference file paths with an `@` prefix, for example `@src/path/to/File.java`.
- Include line numbers, method names, class names, or other stable context so the agent can locate the code.
- Describe the fix precisely: what to find, what to replace, and what behavior to preserve.
- Mention tests when the fix should include a regression test.
- Keep the prompt self-contained. The fixing agent may not see the original review thread.

---

# When to use review notes instead of findings

Use `.review-assist/outputs/review-notes.md` instead of `.review-assist/outputs/new-findings.json` for:

- broad observations about the MR/PR
- risks that are real but not tied to one changed line
- architectural concerns requiring discussion
- issues outside the visible diff
- uncertainty that needs human confirmation
- test coverage concerns without a clear broken behavior
- useful context for reviewers that should not become a blocking positional thread

Use `new-findings.json` only for concrete, actionable issues tied to a visible diff line.

## `outputs/review-notes.md`

This is a public note visible to other MR/PR participants.

Do not reference internal bundle files such as `.review-assist/`, `CONTEXT.md`, `threads/`, `outputs/`, `latest.patch`, or `line-map.json`.

Write as if addressing other developers looking at the MR/PR.

A useful review note may include:

- what areas of the diff you reviewed
- notable findings that were created separately
- broad concerns or follow-up questions
- areas that may deserve human attention

Keep it concise.

---

# MR/PR summary

## `outputs/summary.md`

`.review-assist/outputs/summary.md` describes what the MR/PR changes, not what the reviewer found.

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

* **Added** — new user-facing, API-visible, or operational capabilities.
* **Changed** — changes to existing behavior, workflows, APIs, configuration, logging, validation, or internal processing.
* **Deprecated** — functionality, APIs, options, fields, or behavior that still exists but is now discouraged and planned for removal or replacement.
* **Removed** — functionality, APIs, options, fields, files, or behavior that was removed.
* **Fixed** — corrections for incorrect behavior, regressions, broken edge cases, crashes, or production issues.
* **Security** — security-related fixes or hardening, including authorization, authentication, injection risks, secrets, sensitive data, or audit-relevant behavior.
* **Performance** — measurable or intentional performance, scalability, memory, query, concurrency, or resource-usage improvements.
* **Tests** — added or changed automated tests, test fixtures, or test infrastructure.
* **Documentation** — documentation, comments intended as docs, examples, or user/developer guidance.
* **Internal** — refactoring, cleanup, dependencies, build, CI, formatting, configuration, or other maintenance changes without direct behavior impact.

If a change could fit multiple categories, choose the category that is most useful to someone reading the MR/PR description.

Prefer user- or domain-facing categories over internal ones:

* Use **Added**, **Changed**, **Fixed**, **Security**, or **Performance** when the change affects behavior.
* Use **Tests**, **Documentation**, or **Internal** when the change mainly supports development or maintenance.

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

* Describe what the developer changed, not what the reviewer found.
* Do not include review findings, suspected bugs, risks, approval status, or quality judgments.
* Do not include unresolved thread information.
* Do not mention internal bundle files such as `.review-assist/`, `CONTEXT.md`, `outputs/`, `latest.patch`, or `line-map.json`.
* Do not include a file list.
* Do not write a code walkthrough.
* Do not include empty categories.
* Keep it concise: one bullet per meaningful change.
* Merge tiny related changes into one bullet.
* Use present tense, for example “Adds”, “Changes”, “Deprecates”, “Removes”, “Fixes”, “Improves”, “Updates”.
* Use the project’s own terminology when visible in the code, MR/PR description, or `REVIEW.md`.
* Prefer plain language over implementation jargon unless the implementation detail is the important change.

If the diff is too ambiguous to determine user-facing behavior, summarize the safest observable codebase-level change.

Example:

```md
## Internal

- Refactors mass-registration service logic without changing the public API.
```

Do not invent intent that is not visible from the diff or MR/PR context.

---

# Final checks

Before finishing, check that:

- all required output files were written
- JSON output files are syntactically valid JSON arrays
- every finding has `oldPath`, `newPath`, `body`, `severity`, `category`, and at least one line field
- every finding is anchored to a line in `.review-assist/diffs/line-map.json`
- there are no duplicate findings from existing threads or Previous Actions
- source files were not modified
- findings are concise, concrete, and actionable
- `summary.md` describes MR/PR changes, not review findings
- `review-notes.md` does not reference internal review-assist files

Do not run publishing commands unless the developer explicitly asks.
