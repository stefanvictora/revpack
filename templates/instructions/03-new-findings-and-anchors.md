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
   - Use this for understanding the overall MR/PR, cross-file relationships, renames, broad patterns, and change intent.
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

Important rules:

- Use patch files to understand the code change.
- Use `line-map.ndjson` to validate and choose review anchors.
- Do not calculate old or new line numbers manually from the patch or current workspace.
- Do not infer deleted-code anchors from checked-out files, because deleted lines are not present in the workspace.

## Positional anchors

Use `.revkit/diffs/line-map.ndjson` as the source of truth for valid positional anchors.

Do not calculate `oldLine` or `newLine` manually from the patch. Use the patches to understand changes, not to derive line numbers.

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
