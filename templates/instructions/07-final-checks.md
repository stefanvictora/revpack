# Final self-check

Before finishing, perform a lightweight self-check.

Do not run additional shell commands solely for final verification unless you have a concrete reason to suspect that an output file is malformed or missing.

Check from your current work that:

- the task mode from `CONTEXT.md` was followed
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
