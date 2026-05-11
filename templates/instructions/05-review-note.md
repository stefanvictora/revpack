# MR/PR-level review notes

`outputs/review.md` is for MR/PR-level synthesis.

Default to leaving it empty.

Write it only when there is a concrete concern, confirmation question, or cross-cutting pattern that helps human reviewers or the MR/PR author decide whether the change is complete, coherent, or needs follow-up before merge.

It is not a second findings file, a full review report, an audit log, or a place to duplicate line comments.

Use `new-findings.json` for concrete, actionable issues tied to visible diff lines.

Use `review.md` only for useful MR/PR-level synthesis that does not fit cleanly into a positional finding or thread reply.

## MR/PR-level synthesis pass

After deciding on positional findings and thread replies, perform a short MR/PR-level synthesis.

Only write `review.md` if you can state a concrete concern, confirmation question, or cross-cutting pattern in 1-3 short paragraphs.

Useful MR/PR-level notes often involve:

- an end-to-end feature, workflow, API, or migration that appears incomplete
- cross-file authorization, authentication, audit, validation, or data-access policy inconsistencies
- rollout, migration, compatibility, backfill, configuration, monitoring, or deployment concerns
- transaction boundaries, failure modes, operational assumptions, or cross-cutting dependencies
- test strategy concerns for risky behavior when no specific broken behavior is visible
- repeated naming, terminology, structure, or maintainability patterns across multiple changed files
- multiple inline findings that appear to share one broader root cause
- product, security, or architectural decisions that should be confirmed before merge

A broad concern is useful only when it points to a concrete decision, missing behavior, unclear policy, or follow-up action.

Omit broad observations that are merely interesting, theoretical, or phrased as general advice.

Do not write `review.md` just to prove that files were reviewed, summarize the diff, repeat inline findings, or mention theoretical concerns that do not affect the merge decision.

Do not claim the MR/PR is incomplete merely because future enhancements are possible. A completeness concern should describe a specific broken, missing, inconsistent, or unclear end-to-end path.

## When `review.md` is useful

Use `.revkit/outputs/review.md` instead of `.revkit/outputs/new-findings.json` for useful MR/PR-level concerns that do not fit cleanly into a positional finding, such as:

- lower-confidence concerns that deserve human attention but are not proven enough for a positional finding
- risks that are real but not cleanly anchorable to one changed line
- architectural, product, security, operational, or rollout concerns requiring discussion
- end-to-end completeness concerns spanning multiple files or layers
- migration, compatibility, backfill, configuration, monitoring, or deployment concerns
- possible missing tests where the risk is plausible but no specific broken behavior is visible
- repeated maintainability, naming, terminology, or consistency issues across the MR/PR
- issues outside the visible diff that are directly relevant to the changed behavior
- uncertainty that needs human confirmation

For lower-confidence concerns, state what should be confirmed.

Prefer:

```md
Please confirm whether existing projects need a backfill for this counter.
```

Avoid:

```md
This will break existing projects.
```

## When to leave `review.md` empty

Leave `review.md` empty when:

- all useful feedback is already captured by positional findings or thread replies
- the note would only say which files were reviewed
- the note would only count or summarize inline findings
- the note would mostly repeat the MR/PR summary
- the note would mostly repeat finding bodies
- the only possible note is "looks good", "no issues found", "see inline comments", or similar filler
- the concern is speculative and does not affect the merge decision
- the concern is a future enhancement rather than a concrete completeness gap
- the MR/PR is small and all changed behavior is already clear from `summary.md` and any positional findings
- the only useful feedback is a concrete inline finding that already explains the issue fully

Do not include a reviewed-scope note unless it prevents misunderstanding, such as when the review was intentionally limited to one area of a larger MR/PR.

## Relationship to positional findings

If a concern is concrete, actionable, and anchorable to a visible diff line, prefer a positional finding.

Do not put a concrete bug into `review.md` just because it feels broad or important.

Use `review.md` only when there is additional MR/PR-level synthesis, such as a shared root cause across multiple findings or an unresolved policy question.

If mentioning inline findings is useful, summarize them only when they share a broader root cause or reveal an MR/PR-level concern that is not obvious from the individual comments.

Good:

```md
Several inline findings relate to export authorization and delivery. Together they suggest the MR/PR has not yet settled the export security model: who may request an export, whose data is included, and where the export may be sent.
```

Not useful:

```md
Two inline findings were raised.
```

Do not include detailed fix instructions in `review.md`; those belong in positional findings or thread replies.

## Nitpicks and minor observations

Do not use `review.md` as a dumping ground for arbitrary nitpicks.

Usually omit isolated line-level nitpicks such as local naming preferences, formatting preferences, or minor style opinions.

A minor observation may belong in `review.md` only when it applies at the MR/PR level, for example:

- the MR/PR introduces inconsistent terminology for the same concept across multiple files
- several changed files repeat the same small maintainability issue
- the change creates a naming or structure pattern that future contributors are likely to copy
- the concern is too broad for one positional anchor but still useful to address before merge

Prefer one short MR/PR-level note over several minor positional findings when the issue is a repeated pattern.

Omit minor observations that would not change a developer's merge decision or follow-up work.

## `outputs/review.md`

This file is the optional public review body for the current publish operation.

Write only content that is useful for this publish operation.

Good `review.md` content helps reviewers answer:

> Is this MR/PR complete, coherent, or in need of follow-up before merge?

Do not use `review.md` as:

- a full review report
- a file-by-file walkthrough
- an audit log of what you inspected
- a duplicate copy of positional findings
- a table of all findings
- thread bookkeeping
- an approval message
- a place for arbitrary nitpicks
- filler when there is nothing useful to say

Do not write filler such as "No new findings", "Nothing to report", "Reviewed without comments", "Looks good", or "See inline comments".

Do not reference internal bundle files such as `.revkit/`, `CONTEXT.md`, `threads/`, `outputs/`, `latest.patch`, or `line-map.ndjson`.

Write as if addressing other developers looking at the MR/PR.

Keep it concise. In most cases, 1-3 short paragraphs are enough.

## Avoid broad approval language

Avoid broad approval or certification language.

Do not write:

- "Everything looks good"
- "No issues found"
- "Ready to merge"
- "The implementation is correct"
- "The MR/PR is safe"

Prefer scoped wording when useful:

- "I did not find issues in the changed credential-helper path."
- "The auth checks in the changed mutation follow the same pattern as the adjacent mutations."
- "The remaining concern is limited to the test provider."

Do not claim that tests pass, builds succeed, or the MR/PR is fully validated unless that information is explicitly present in the MR/PR context.

## Do not use review notes for thread bookkeeping

Do not use `review.md` for thread bookkeeping.

Avoid listing existing thread IDs, saying which threads were skipped, or explaining that no reply was added.

Put useful thread responses in `replies.json`; otherwise omit them.

## Suggested shape

When `review.md` is useful, prefer one of these shapes:

```md
[One concrete MR/PR-level concern, confirmation question, or pattern note.]
```

or:

```md
[One sentence connecting multiple inline findings to a broader root cause.]

[One concrete MR/PR-level concern, confirmation question, or pattern note.]
```

or:

```md
[One sentence explaining that the review was intentionally limited to a specific area, if that prevents misunderstanding.]

[One concrete MR/PR-level concern, confirmation question, or pattern note.]
```

Avoid count-only or report-like structures.

Bad:

```md
Reviewed three files. Two findings were raised.
```

Good:

```md
The inline findings around export authorization and destination-email handling point to the same unresolved policy question: whether exports are user-owned operations or project-admin operations.
```

## Good examples

Good because it synthesizes multiple findings into one broader policy concern:

```md
Several inline findings relate to export authorization and delivery. Together they suggest the MR/PR has not yet settled the export security model: who may request an export, whose data is included, and where the export may be sent.
```

Good because it identifies an end-to-end completeness concern:

```md
One completeness concern: the PR adds a backend query and a copy-link button, but the generated URL does not appear to map to a route that opens the target entity. The individual pieces are reviewable, but the end-to-end user flow may not be complete yet.
```

Good because it identifies a rollout concern that is not cleanly tied to one line:

```md
One rollout concern: the MR/PR adds a new aggregate table for task counts, but the diff does not show a backfill or migration path for existing projects. If the counter is intended to start from zero for existing data, that behavior should be explicit; otherwise existing dashboards may show inconsistent counts after deployment.
```

Good because it raises a repeated minor pattern at MR/PR level rather than as several nitpicks:

```md
Minor consistency note: the MR/PR uses both "export request" and "report request" for the same user-facing operation. Aligning the terminology would make the flow easier to follow and reduce the chance that future code treats them as separate concepts.
```

## Bad examples

Bad because it duplicates a positional finding:

```md
## High — missing authorization

The handler does not call `getAuthUserId` and does not verify membership. Any unauthenticated client can call the endpoint.

Fix: add the standard auth and membership guard.
```

Bad because it is only a review report:

```md
Reviewed `exports.ts`, `schema.ts`, and `ExportButton.tsx`. One high finding and one medium finding were raised. See inline comments.
```

Bad because it is filler:

```md
No other issues found. Looks good overall.
```

Bad because it overstates validation:

```md
The implementation is correct and ready to merge.
```

Bad because it treats a possible future enhancement as incompleteness:

```md
The PR does not add export scheduling, so the export feature is incomplete.
```

Bad because the useful feedback belongs only in the positional finding:

```md
One issue was found in null handling.
```

---
