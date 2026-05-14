# New findings and positional anchors

## Quality bar

Use `outputs/new-findings.json` for concrete, actionable issues that should become positional review threads. Prefer fewer, higher-value findings over many speculative ones.

Create a finding only when **all** of these are true:

1. The issue is introduced, exposed, or made worse by this MR/PR.
2. The issue is visible from the diff or directly caused by changed code.
3. The impact is concrete: incorrect behavior, security risk, data loss, broken API contract, performance regression, missing test for risky behavior, or maintainability problem with real future risk.
4. The finding can be explained in 1–3 concise paragraphs.
5. No existing thread, previous action, or other new finding already covers it.

Do not create findings for speculative issues, broad refactoring preferences, style opinions (unless affecting readability in changed code), unrelated pre-existing problems, or theoretical performance concerns without evidence.

## Review changed behavior, not just changed lines

When reviewing a changed line, also inspect the surrounding method, class, or call path. Ask:

- What behavior changed? What inputs can reach this code?
- What happens on null, empty, invalid, duplicate, unauthorized, or failed external calls?
- Does the change preserve existing API, database, security, audit, or compatibility behavior?
- Are existing tests still meaningful, or did the change bypass them?

Create positional findings only on lines listed in `line-map.ndjson`.

## Diff navigation

The workspace contains only the new branch state. Deleted lines do not exist in checked-out files.

| Artifact                   | Use for                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `diffs/files.json`         | Navigation, file selection, locating per-file patches. Not for review anchors.                             |
| `diffs/latest.patch`       | Overall MR/PR understanding, cross-file relationships, change intent.                                      |
| `diffs/patches/by-file/`   | Detailed review of individual files (preferred over full patch).                                           |
| `diffs/line-map.ndjson`    | **Source of truth** for valid positional anchors. Every finding must reference a line here.                |
| `diffs/change-blocks.json` | Understanding larger edits and replacement relationships. `preferredCommentTarget` gives a default anchor. |

**Do not** calculate line numbers manually from patches or checked-out files. Use patches to understand changes; use `line-map.ndjson` to choose anchors.

## Positional anchors

Each finding must anchor to exactly one `line-map.ndjson` entry:

| `kind`    | Use                          |
| --------- | ---------------------------- |
| `added`   | `newLine` only               |
| `removed` | `oldLine` only               |
| `context` | both `oldLine` and `newLine` |

Prefer added-line anchors — they are the clearest for issues introduced by the MR/PR. Use removed-line anchors only for harmful deletions. A line in the workspace but not in `line-map.ndjson` is not valid for a finding.

## Duplicate avoidance

Before creating a finding, check existing unresolved threads, Previous Actions in CONTEXT.md, and your other new findings. Same root cause = duplicate, even on a nearby line. One root cause across nearby lines → one finding at the clearest changed line.

## `outputs/new-findings.json`

JSON array. Required fields: `oldPath`, `newPath`, `body`, `severity`, `category`, and at least one of `oldLine`/`newLine`. For non-renamed files, paths are usually identical.

<example>

```json
[
  {
    "oldPath": "src/app.ts",
    "newPath": "src/app.ts",
    "newLine": 42,
    "body": "**Potential null dereference**: `user.name` is accessed without a null check.\n\nThe changed code reads `user.name` before validating that `user` exists. If the API receives a request without a resolved user, this fails with a runtime error instead of the expected validation response.\n\nSuggested fix: guard the access or return the existing validation response before reading the property.\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\nVerify this issue against the current code and only fix it if still applicable.\n\nIn `@src/app.ts` around line 42, add a guard before accessing `user.name`. Preserve the existing response behavior for missing users.\n\n</details>",
    "severity": "high",
    "category": "correctness"
  }
]
```

</example>

## Finding body format

````md
**Short issue title**: Concrete problem and why it matters.

The changed code does X, but in condition Y this causes Z.

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

Omit the suggestion block when the replacement is not safe or complete.
Omit the handover prompt when the fix is trivial and the suggestion suffices.
Keep findings concise — no long code walkthroughs.

## Severity

Choose based on concrete impact, not how suspicious the code looks. If you cannot explain the impact, do not use `high` or `blocker`.

| Severity  | Meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `blocker` | Breaks core functionality, data loss, or serious security issue                   |
| `high`    | Likely production bug, security issue, broken API contract, or serious regression |
| `medium`  | Realistic edge case or maintainability issue that can cause future bugs           |
| `low`     | Minor risk or small robustness improvement                                        |
| `nit`     | Cosmetic or naming; use rarely                                                    |

## Categories

Use only: `security`, `correctness`, `performance`, `testing`, `architecture`, `style`, `documentation`, `naming`, `error-handling`, `general`.

---
