# Thread replies

Use `.revpack/threads/` and the active review thread overview in `.revpack/CONTEXT.md`.

## When to reply

Only write a reply when it adds useful information for a human reviewer or the author. An active review thread does not require a reply just because it exists.

Reply when any of the following applies.

- the thread asks a concrete question you can answer
- the thread reports an issue and you can confirm it is fixed (no human has already confirmed)
- you can provide a fix suggestion or disagree with a clear technical reason
- follow-up discussion needs clarification
- the thread's issue is now fixed and your reply can conclusively close the discussion

Do not reply to acknowledgements, placeholder comments, general notes without a code concern, or threads where your only response would be "acknowledged" / "no action needed". If a human already confirmed the issue as fixed and the code agrees, omit the thread.

Skip **SELF** threads unless they have new follow-up or you are resolving them.
Skip **REPLIED** threads unless you have new information.

Set `"resolve": true` when your reply conclusively completes the discussion. Publishing posts the reply before attempting resolution, so a provider reporting the thread as non-resolvable before the reply does not prevent you from expressing resolution intent.

For a fix made with `revpack-context`, describe the verified change in terms that will still be accurate when the reply is published. If the fix fully addresses the concern, set `"resolve": true` even while the change is awaiting commit or push.

Keep `"resolve": false` for questions, partial fixes, suggested future work, or any reply that should continue the discussion.

When proposing a fix, read `.revpack/instructions/04-suggestions-and-agent-handover.md` before drafting a code suggestion or a coding-agent handover. A safe local replacement can be paired with a handover for tests, imports or changes elsewhere.

## System events

Thread files may contain system events (e.g. "changed this line in version 3 of the diff"), indicating the author may have pushed a fix. Always verify in the code — do not assume the issue is fixed just because a system event exists.

## `outputs/replies.json`

JSON array of replies. Create this file only when at least one thread needs a useful reply. Only include threads you are actually replying to.

Required fields: `threadId`, `body`, `resolve`
Optional: `generation`; `disposition` — one of `already_fixed`, `explain`, `suggest_fix`, `disagree`, `escalate`

Set `generation.model` to the exact runtime model name exposed to you. Do not infer it from the agent product, adapter, provider, or model family, and never guess. If your runtime does not expose the model name, omit `generation`; revpack will publish a generic AI attribution instead.

<example>

These drafts come from successive runs. The first runtime reported `Claude Fable 5`. The second did not expose a model name.

```json
[
  {
    "threadId": "T-001",
    "disposition": "suggest_fix",
    "generation": { "model": "Claude Fable 5" },
    "body": "The CSV writer still treats a zero balance as missing. Check for null here so zero is included in the export.",
    "resolve": false
  },
  {
    "threadId": "T-002",
    "disposition": "already_fixed",
    "body": "Both export handlers now call `recordAuditEvent` before sending the response, including the early return for an empty export.",
    "resolve": true
  }
]
```

</example>
