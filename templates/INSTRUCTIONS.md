# Review Instructions

Read `.revkit/CONTEXT.md` first. It contains the MR/PR-specific metadata, changed files, existing threads, previous actions, and bundle layout.

These instructions are the stable contract for how an agent should review the prepared workspace bundle and write output files.

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

## Output validation

revkit may mechanically validate required files, JSON syntax, output schemas, and positional anchors before publishing.

Your job is to write the required output files correctly. Do not spend extra tool calls re-validating conditions that revkit can check deterministically.

## Input files to read

Start with:

1. `.revkit/CONTEXT.md`
2. `.revkit/INSTRUCTIONS.md`
3. `REVIEW.md`, if present
4. `.revkit/diffs/files.json`
5. `.revkit/diffs/latest.patch`

Then use:

- `.revkit/diffs/patches/by-file/` for focused per-file review
- `.revkit/diffs/line-map.ndjson` for positional review anchors
- `.revkit/diffs/change-blocks.json` for larger insert/delete/replace relationships
- `.revkit/diffs/views/` only as optional readability aids

Use checked-out source files to understand the current MR/PR state when the diff alone is not enough.

`REVIEW.md` is the project-specific review policy. Use it for project priorities, terminology, conventions, known false positives, testing expectations, and security expectations.

---

# Existing thread replies

Use `.revkit/threads/` and the unresolved thread overview in `.revkit/CONTEXT.md`.

`outputs/replies.json` must contain only replies that should actually be posted back to the MR/PR.

Do not include entries for threads you decided to ignore.

An unresolved thread does not require a reply just because it is unresolved.

Only write a reply when the reply adds useful information for another human reviewer or author.

Write a reply only when one of these is true:

- the thread asks a concrete question and you can answer it
- the thread reports a concrete issue, no human has already confirmed it as fixed/addressed, and you can confirm it is fixed
- the thread reports a concrete issue and you can provide a fix suggestion
- the thread reports a concrete issue and you disagree with a clear technical reason
- the thread has follow-up discussion that needs clarification
- the thread was created by revkit (**SELF**) and you can resolve it because the issue is now fixed

Do not reply to:

- test comments
- placeholder comments
- acknowledgements
- comments without a concrete code concern
- general notes that do not require an answer
- threads where your only response would be “acknowledged”, “no action needed”, “nothing to do”, or “no code change suggested”
- threads where a human already confirmed the issue was fixed/addressed and the current code agrees
  - Human comments such as “fixed”, “done”, “removed”, “addressed”, “changed”, “resolved”, or equivalent wording count as human confirmation.

For those cases, omit the thread from `outputs/replies.json`.

Skip threads marked **SELF** unless they have new follow-up from others or you are resolving your own previously published finding.

Skip threads marked **REPLIED** unless you have new information to add.

Set `"resolve": true` only for threads you created yourself (**SELF** threads). Do not resolve threads created by other reviewers.

## `outputs/replies.json`

Write replies to existing threads as a JSON array.

If no existing thread needs a useful reply, write:

```json
[]
```

Example:

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
- `explain`
- `suggest_fix`
- `disagree`
- `escalate`

If the reply does not add technical value, omit it.

---

# New findings

Use `.revkit/outputs/new-findings.json` only for concrete, actionable issues that are specific enough to justify a positional review thread.

Prefer fewer, higher-value findings over many speculative findings.

## Review quality bar

Use `.revkit/outputs/new-findings.json` for concrete, actionable issues that should become positional review threads.

Prefer fewer, higher-value findings over many speculative findings. Findings do not need to be severe, but they must be useful, specific, and tied to a real risk.

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

Do not limit your reasoning to the added lines, but only create positional findings on lines listed in `.revkit/diffs/line-map.ndjson`.

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

## Diff navigation

The workspace contains only the new branch state. Deleted lines do not exist in the workspace, so do not infer old-side line numbers from checked-out files.

Use the diff artifacts by purpose:

1. `diffs/files.json`
   - Changed-file index with file status, added/removed counts, binary flag, hunk ranges, and per-file patch paths.
   - Use this first for navigation, file selection, and deciding which per-file patches to inspect.
   - Do not use this as the source of truth for review anchors.

2. `diffs/latest.patch`
   - The canonical full unified diff for the whole MR/PR.
   - Use this for understanding the overall MR, cross-file relationships, renames, broad patterns, and change intent.
   - Prefer focused per-file patches when reviewing one specific file.

3. `diffs/patches/by-file/`
   - Canonical per-file unified diffs in standard patch format.
   - Prefer these for detailed review of individual files.
   - Use these as the primary source for understanding added, removed, and changed code in that file.

4. `diffs/line-map.ndjson`
   - Canonical per-line map for valid positional review anchors.
   - Every review finding must anchor to a line present here.
   - `kind: "added"` means use `newLine`.
   - `kind: "removed"` means use `oldLine`.
   - `kind: "context"` means use both `oldLine` and `newLine`.
   - `oldLine: null` means the line does not exist in the old version.
   - `newLine: null` means the line does not exist in the new workspace.

5. `diffs/change-blocks.json`
   - Grouped insert/delete/replace blocks.
   - Use this to understand larger edits, harmful deletions, and replacement relationships.
   - `preferredCommentTarget` gives a good default anchor for block-level findings.

6. `diffs/views/`
   - Optional annotated convenience views, if present.
   - Use these only as a readability aid when helpful.
   - Do not treat them as canonical if they disagree with the patch files or `line-map.ndjson`.

Important rules:

- Use patch files to understand the code change.
- Use `line-map.ndjson` to validate and choose review anchors.
- Do not calculate old or new line numbers manually from the patch or current workspace.
- Do not infer deleted-code anchors from checked-out files, because deleted lines are not present in the workspace.

## Positional anchors

Use `.revkit/diffs/line-map.ndjson` as the source of truth for valid positional anchors.

Do not calculate `oldLine` or `newLine` manually from the patch. Use the annotated diff to understand changes, not to derive line numbers.

Each finding location must exactly match one line-map entry:

- `kind: "added"` → use `newLine` only
- `kind: "removed"` → use `oldLine` only
- `kind: "context"` → use both `oldLine` and `newLine`

Do not anchor a finding to a line that is not present in `.revkit/diffs/line-map.ndjson`.

Prefer findings on added lines. They are usually the clearest anchors for issues introduced by the MR/PR.

Use removed-line findings only for harmful deletions.

Use context-line findings only when the context line is visible in the line map and is the clearest stable anchor.

A line that exists only in the checked-out source file but is not listed in the line map is not valid for a positional finding.

## Duplicate finding avoidance

Before creating a new finding, check:

1. Existing unresolved threads.
2. Previous Actions in `.revkit/CONTEXT.md`.
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
- the changed lines are visible in `.revkit/diffs/line-map.ndjson`
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

A handover prompt is especially useful for:

- findings that require edits in multiple places
- fixes that require adding or updating tests
- fixes that may need imports, method signature changes, or refactoring
- replies where an existing thread asks for a change and the fix is more than a small one-line suggestion
- cases where a suggestion block would be too large or fragile

If a small local code suggestion is possible, include it even when you also include a handover prompt.

Good pattern:

1. Explain the issue in the finding or reply.
2. Provide a small suggestion block for the direct local fix, if safely applicable.
3. Add a handover prompt for tests, imports, related changes, or broader cleanup.

### Write for a fixing agent with limited context

Write handover prompts for a fixing agent that may only see the current workspace.

Avoid relying on hidden review context. Do not say “restore the removed code”, “use the original implementation”, “revert this change”, or “add back the previous call” unless you also describe the desired final behavior or include the exact code/pattern to restore.

Prefer behavior-oriented wording:

- “Ensure successful exports emit DSG audit logging before the file response is written.”
- “Persist DMS containers for every successful submission with at least one registration.”
- “Return a dynamic selectable year range instead of the placeholder value `0`.”

When exact parameters or conventions matter, tell the fixing agent where to derive them:

- “Follow the existing DSG logging conventions in this controller.”
- “Use the same response handling pattern as the adjacent endpoint.”
- “Preserve the existing validation and error handling behavior.”

### Format

Use this format:

```md
<details>
<summary>🤖 Prompt for AI Agents</summary>

Verify this issue against the current code and only fix it if still applicable.

In `@src/path/to/File.java` around `methodName(...)`, change the current behavior so that [desired behavior].

Preserve [important existing behavior, if relevant].

Add or update tests covering [specific scenario].

</details>
```

### Rules

- Reference file paths with an `@` prefix, for example `@src/path/to/File.java`.
- Include line numbers, method names, class names, or other stable context so the fixing agent can locate the code.
- Describe the desired final behavior, not only the suspected cause.
- Describe what behavior should be preserved when the fix touches validation, authorization, persistence, API responses, logging, or error handling.
- Mention tests when the fix should include a regression test.
- Keep the prompt self-contained. The fixing agent may not see the review thread, MR/PR diff, or previous implementation.
- Keep it concise. A good handover prompt usually has one location sentence, one behavior sentence, one preservation sentence if needed, and one test sentence.

---

# When to use review notes instead of findings

Use `.revkit/outputs/review.md` instead of `.revkit/outputs/new-findings.json` for:

- lower-confidence concerns that deserve human attention but are not proven enough for a positional finding
- minor maintainability observations that are useful but not worth opening a separate thread
- possible missing tests where the risk is plausible but no specific broken behavior is visible
- broad observations about the MR/PR
- risks that are real but not tied to one changed line
- architectural concerns requiring discussion
- issues outside the visible diff
- uncertainty that needs human confirmation

Use `new-findings.json` only for concrete, actionable issues tied to a visible diff line.

## `outputs/review.md`

This file is the optional public review body for the current publish operation.

Write only content that is useful for this publish operation.

Use it for review information that is useful to publish but does not belong in a positional finding or thread reply, such as:

- what areas of the diff you reviewed
- notable findings that were created separately, without duplicating their full text
- broad concerns or follow-up questions
- areas that may deserve human attention
- lower-confidence concerns that are useful for human attention, but not proven enough for a positional finding

Do not reference internal bundle files such as `.revkit/`, `CONTEXT.md`, `threads/`, `outputs/`, `latest.patch`, or `line-map.ndjson`.

Write as if addressing other developers looking at the MR/PR.

If there is no useful review body for the current publish operation, leave the file empty. Do not write filler such as "No new findings", "Nothing to report", or "Reviewed without comments".

Keep it concise.

---

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

# Final self-check

Before finishing, perform a lightweight self-check.

Do not run additional shell commands solely for final verification unless you have a concrete reason to suspect that an output file is malformed or missing.

Check from your current work that:

- all required output files were written
- JSON output files are valid JSON arrays
- every finding has `oldPath`, `newPath`, `body`, `severity`, `category`, and at least one line field
- every finding is anchored to a line in `.revkit/diffs/line-map.ndjson`
- there are no duplicate findings from existing threads or Previous Actions
- findings are concise, concrete, and actionable
- `summary.md` describes MR/PR changes, not review findings
- `review.md` does not reference internal revkit files

Do not run build, test, lint, format, package-manager, migration, Docker, application-startup, Git-hook, publishing, or repository-audit commands.

Do not run `git status`, `git diff`, or similar commands just to prove that source files were not modified.

If you accidentally modified files outside `.revkit/outputs/`, report that explicitly instead of trying to hide or repair it.

---

# Language and encoding

## Reply language

Match the language of the thread you are replying to.

If the thread comments are in German, reply in German. If in English, reply in English. If mixed, prefer the language of the most recent human comment.

Do not switch languages within a single reply.

## UTF-8 encoding

All output files are read and written as UTF-8. Use proper Unicode characters — including umlauts (ä, ö, ü, ß), accented characters, and other non-ASCII text.

Do not omit, escape, or transliterate special characters. For example, write "Änderung" not "Aenderung".

---

# System events in threads

Thread files in `.revkit/threads/` may contain **system events** (e.g. "changed this line in version 3 of the diff").

These events indicate that the MR author may have pushed changes that address the feedback in the thread, even if no comment was left.

When you see a system event in a thread:

1. Check the current source code to see if the issue was actually fixed.
2. If the issue is fixed, you may resolve the thread (if it is a **SELF** thread) or note that it appears fixed.
3. Do not assume the issue is fixed just because a system event exists — verify in the code.
