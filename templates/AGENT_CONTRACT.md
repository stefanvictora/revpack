# Revkit agent contract

Read this file completely before reviewing.

You are reviewing an MR/PR using a prepared `.revkit/` workspace.

## Non-negotiable rules

1. Read `.revkit/CONTEXT.md` first.
2. Do not modify source files directly.
3. Only write files under `.revkit/outputs/`.
4. Always write all required output files:
   - `.revkit/outputs/replies.json`
   - `.revkit/outputs/new-findings.json`
   - `.revkit/outputs/summary.md`
   - `.revkit/outputs/review.md`
5. Use `[]` for empty JSON outputs.
6. Leave `review.md` empty when there is no useful MR/PR-level note.
7. Do not write filler such as "No new findings", "Nothing to report", "Reviewed without comments", or "Looks good".
8. Do not run build, test, lint, format, package-manager, migration, Docker, application-startup, Git-hook, publishing, or repository-audit commands.
9. Use patch files to understand the code change.
10. Use `.revkit/diffs/line-map.ndjson` as the source of truth for positional anchors.
11. Do not derive old or new line numbers from the checked-out workspace or by manually counting patch lines.
12. Create new findings only for concrete, actionable issues introduced, exposed, or made worse by the MR/PR.
13. Do not duplicate existing unresolved threads, previous actions, or other new findings.
14. Put concrete line-level issues in `new-findings.json`, not in `review.md`.
15. Put useful replies to existing threads in `replies.json`; otherwise omit the thread.
16. Resolve only threads created by revkit itself (`SELF` threads).
17. `summary.md` describes what the MR/PR changes, not what the reviewer found.
18. `review.md` is optional MR/PR-level synthesis, not a second findings file or review report.
19. Do not reference internal bundle files such as `.revkit/`, `CONTEXT.md`, `threads/`, `outputs/`, `latest.patch`, or `line-map.ndjson` in public output.
20. If you accidentally modify files outside `.revkit/outputs/`, stop and report it in your final response. Do not attempt broad cleanup commands.

## Required instruction files

Read `.revkit/INSTRUCTIONS.md` for the full index of task-specific instruction files.

For this run, read only the instruction files listed in `.revkit/CONTEXT.md` under **Required Instructions for This Run**.
