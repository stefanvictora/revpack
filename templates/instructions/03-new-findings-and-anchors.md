# New findings and positional anchors

## Review the change in context

What problem remains without this change? Use the stated intent when available. If it is unstated, review the observable behavior. Use applicable `REVIEW.md` guidance to form a lightweight internal Risk Inventory and focus on changes where a mistake would matter most.

For a new capability or changed business rule, look where the project handles that use case. Does an existing path already meet the need? Does the proposed approach deliver the intended outcome end to end? Raise a design concern when you can show a missed requirement, a conflict with a documented decision or a concrete cost of maintaining two paths.

In higher-risk areas, trace affected callers and consumers through relevant edge cases or failure paths. Compare the resulting behavior with existing tests and documented contracts or architecture decisions. A test added alongside an implementation can encode the same mistaken assumption.

For changed source comments, consider what a future maintainer learns about a decision or constraint. Flag a misleading claim or a retelling of the implementation discussion when it obscures how the code works.

## Quality bar

Before reporting a finding, try to disprove it. For a behavior claim, trace a reachable scenario and check whether a caller, guard or fallback already handles it. For a design or documentation concern, compare the specific code and project evidence involved. Keep a finding only when all of the following hold.

- This MR/PR introduces, exposes or worsens the issue, and the current diff has a valid positional anchor for it.
- You can identify who or what is affected and how. For a test gap, name the specific regression it could miss.
- The author can act on it and the existing discussion has not already covered it.

If a merge decision depends on intent that the available evidence leaves open, check the existing discussion before raising a focused question in the optional Review Note. An absent rationale alone does not warrant a comment.

## Incremental review scope

In incremental code review, the checkpoint delta is the primary review focus, not the boundary for valid findings.

Report a concrete issue outside the checkpoint delta when it is introduced, exposed, or made worse by the current MR/PR, is not already covered by an active review thread, Previous Action, or another finding, and can be anchored to a valid current MR/PR diff position.

Do not remove a valid finding solely because it is outside the checkpoint delta. A previous review pass that missed the issue is not duplicate coverage.

## Diff navigation

The workspace contains only the new branch state. Deleted lines do not exist in checked-out files.

| Artifact                 | Use for                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `diffs/files.json`       | Navigation, file selection, paths, and authoritative per-file patch and Anchor Map paths. Not itself an anchor.   |
| `diffs/latest.patch`     | Overall MR/PR understanding, cross-file relationships, change intent.                                             |
| `diffs/patches/by-file/` | Detailed review of individual files selected through `diffs/files.json` (preferred over full patch).              |
| `diffs/anchor-maps/`     | **Source of truth** for valid positional anchors. Every finding must reference a record in a per-file Anchor Map. |

**Do not** calculate line numbers manually from patches or checked-out files. Use patches to understand changes; use Anchor Maps to choose anchors.

## Positional anchors

Every finding position must use exact Anchor Map records. A single-line finding uses one record; a Code Span uses one record for each endpoint. Looking up the required records is an input step for writing a finding; revpack's later validation is the mechanical safety check, not a substitute for choosing the anchors.

To publish a finding on a contiguous Code Span, use the selected span's last Anchor Map record for `oldLine`/`newLine` and its first record for `oldStartLine`/`newStartLine`. Apply the same line-field rules below independently to each endpoint. Omit start fields for single-line findings. Both endpoints must be in the same diff hunk, and the start must precede the end.

| `kind`    | Required line fields         |
| --------- | ---------------------------- |
| `added`   | `newLine` only               |
| `removed` | `oldLine` only               |
| `context` | both `oldLine` and `newLine` |

Before writing each finding:

1. Find the exact Anchor Map record you want to comment on. Use the file's `anchorMapFile` from `diffs/files.json`, or search all of `diffs/anchor-maps/` by a distinctive text snippet.
2. Match the Anchor Map filename to its `fileId` entry in `diffs/files.json`, then copy that entry's `oldPath` and `newPath`.
3. Set line fields only from the Anchor Map record:
   - `added` → `newLine`
   - `removed` → `oldLine`
   - `context` → both `oldLine` and `newLine`
4. Never invent, shift, approximate, or use the nearest visible workspace line as an anchor.
5. If the issue is about deleted code, anchor to the `removed` line itself.

Prefer added-line anchors — they are the clearest for issues introduced by the MR/PR. Use removed-line anchors only for harmful deletions.

Do not anchor a deletion finding to the next surviving line in the new file. A nearby `context` line is only valid if the finding is about that surviving line, and then both `oldLine` and `newLine` must be provided.

If the relevant Anchor Map record omits `newLine`, the finding must not contain `newLine`.
If the relevant record omits `oldLine`, the finding must not contain `oldLine`.
If the relevant record has both line numbers, the finding must contain both, even when their values are equal.

A line in the workspace but not in a per-file Anchor Map is not valid for a finding.

## Duplicate avoidance

Before creating a finding, check existing active review threads, Previous Actions in CONTEXT.md, and your other new findings. Same root cause = duplicate, even on a nearby line. One root cause across nearby lines → one finding at the clearest changed line.

When a prospective finding appears to repeat earlier feedback, consult relevant files in `.revpack/resolved-threads/` on demand. Treat a resolved thread as duplicate coverage only when the same issue remained continuously applicable. If the issue was fixed and later reintroduced, it may be reported as a new finding.

## `outputs/new-findings.json`

JSON array. Create this file only when you have at least one finding. Required fields: `oldPath`, `newPath`, `body`, `severity`, `category`, and at least one of `oldLine`/`newLine`. Optional: `generation`; `oldStartLine`/`newStartLine` fields turn that endpoint into a multi-line Code Span. For non-renamed files, paths are usually identical.

Set `generation.model` to the exact runtime model name exposed to you. Do not infer it from the agent product, adapter, provider, or model family, and never guess. If your runtime does not expose the model name, omit `generation`; revpack will publish a generic AI attribution instead.

<example>

```json
[
  {
    "oldPath": "src/app.ts",
    "newPath": "src/app.ts",
    "newLine": 42,
    "body": "**Anonymous requests return 500**: This handler reads `user.name` before checking whether the request has a user. Return the existing 401 response before accessing the name.",
    "severity": "high",
    "category": "correctness"
  }
]
```

</example>

## Finding body format

Lead with a short bold title. Explain the trigger and consequence in 1–3 short paragraphs. Give a fix direction when one is clear. For a directly applicable code suggestion or a fix that needs a coding-agent handover, read `.revpack/instructions/04-suggestions-and-agent-handover.md`.

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

Prefer: `security`, `correctness`, `reliability`, `compatibility`, `observability`, `performance`, `testing`, `architecture`, `style`, `documentation`, `naming`, `error-handling`, `general`.

---
