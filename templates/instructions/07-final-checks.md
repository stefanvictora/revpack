# Final self-check

Before finishing, perform a lightweight self-check.

Before finishing a fresh or incremental review, revisit the Risk Inventory for gaps in review coverage and try to disprove each remaining candidate finding. Keep only concerns with a reachable failure scenario and concrete impact that were introduced, exposed, or made worse by the MR/PR, are not prevented by surrounding safeguards or safe fallback behavior, and are not already covered.

Do not run additional shell commands solely for final verification unless you have a concrete reason to suspect that an output file is malformed or missing.

Check from your current work that:

- the task mode from `CONTEXT.md` was followed
- `summary.md` was written for fresh or incremental code review runs
- conditional output files were omitted when they have no useful draft material
- any JSON output files you wrote are valid JSON arrays
- every finding has `oldPath`, `newPath`, `body`, `severity`, `category`, and at least one line field
- every finding is anchored to a record in the corresponding per-file Anchor Map listed in `.revpack/diffs/files.json`
- no finding duplicates an active review thread, a continuously applicable issue in a relevant resolved thread, a Previous Action, or another finding
- findings are concise, concrete, and actionable
- in incremental mode, no valid finding was removed solely because it is outside the checkpoint delta; remove it only if it is not MR/PR-caused, is already covered, is not concrete/actionable, or has no valid positional anchor
- `summary.md` describes MR/PR changes, not review findings
- `note.md` does not reference internal revpack files

Do not run build, test, lint, format, package-manager, migration, Docker, application-startup, Git-hook, publishing, or repository-audit commands.

Do not run `git status`, `git diff`, or similar commands just to prove that source files were not modified.

If you accidentally modified files outside `.revpack/outputs/`, report that explicitly instead of trying to hide or repair it.

---
