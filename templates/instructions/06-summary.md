# MR/PR summary

Write `outputs/summary.md` for someone reading the MR/PR description before opening the diff. Describe what the current MR/PR changes. On an incremental review, update the existing summary to cover the whole MR/PR.

## Categories

Use `##` headings for populated categories in the order `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Performance`, `Tests`, `Documentation`, `Internal`. Omit release headings and dates.

Choose each category relative to the behavior before the MR/PR. A new capability stays `Added` on follow-up reviews. Use `Changed` for alterations to an existing capability or workflow. Group related implementation and tests under the outcome they support. Use `Tests` for independently important coverage, `Documentation` for human-facing docs and `Internal` for work whose architecture, risk or maintenance impact matters to reviewers.

## Writing the summary

Give each distinct outcome one present-tense bullet in the project's terminology. A small change can take one bullet. Most non-trivial reviews fit in 3–6 bullets across all categories. Include motivation or rollout and testing steps only when the supplied description, commit messages or project guidance explicitly support them. When intent is ambiguous, describe the observable change.

Keep review feedback in findings, replies or the optional Review Note.

```md
## Added

- Adds local review mode so developers can review a branch before opening a pull request.
```
