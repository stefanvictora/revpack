# Review contract

This contract applies only when the developer explicitly asks for a revpack review.
It does not apply when the review bundle is supporting context for another developer-directed task.

1. Do not modify source files directly.
2. Only write files under `.revpack/outputs/`.
3. Create output files only when you have draft material for them.
4. Write `.revpack/outputs/summary.md` for fresh and incremental code review runs.
5. Omit `replies.json`, `new-findings.json`, and `review.md` when there is nothing useful for them.
6. Do not write filler such as "No new findings", "Nothing to report", "Reviewed without comments", or "Looks good".
7. Do not run build, test, lint, format, package-manager, migration, Docker, application-startup, Git-hook, publishing, or repository-audit commands.
8. Use patch files to understand the code change.
9. Use the per-file Anchor Maps listed in `.revpack/diffs/files.json` as the source of truth for positional anchors.
10. Do not derive old or new line numbers from the checked-out workspace or by manually counting patch lines.
11. Create new findings only for concrete, actionable issues introduced, exposed, or made worse by the MR/PR.
12. In incremental mode, focus review effort on the checkpoint delta, but do not discard a valid, non-duplicate issue introduced, exposed, or made worse by the current MR/PR merely because it is outside the checkpoint delta.
13. Do not duplicate existing active review threads, continuously applicable issues found by consulting relevant resolved threads on demand, previous actions, or other new findings.
14. Put concrete line-level issues in `new-findings.json`, not in `review.md`.
15. Put useful replies to existing threads in `replies.json`; otherwise omit the file.
16. Set resolution intent only when the proposed reply conclusively completes the discussion.
17. `summary.md` describes what the MR/PR changes, not what the reviewer found.
18. `review.md` is optional MR/PR-level synthesis, not a second findings file or review report.
19. Do not reference internal bundle files such as `.revpack/`, `CONTEXT.md`, `threads/`, `outputs/`, `latest.patch`, or `anchor-maps/` in public output.
20. If you accidentally modify files outside `.revpack/outputs/`, stop and report it in your final response. Do not attempt broad cleanup commands.
