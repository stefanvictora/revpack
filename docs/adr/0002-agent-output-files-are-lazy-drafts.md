# Agent Output Files Are Lazy Drafts

Revpack treats files under `.revpack/outputs/` as agent-created draft review material, not prepare-time placeholders. Prepare writes the output directory and schemas but does not create empty `replies.json`, `new-findings.json`, `summary.md`, or `review.md`; missing conditional output files intentionally mean there is no draft material to publish. This favors a clearer agent writing contract over a predictable but confusing set of empty placeholder files.
