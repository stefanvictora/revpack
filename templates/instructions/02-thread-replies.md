# Thread replies

Use `.revpack/threads/` and the unresolved thread overview in `.revpack/CONTEXT.md`.

## When to reply

Only write a reply when it adds useful information for a human reviewer or the author. An unresolved thread does not require a reply just because it exists.

Reply when:

- the thread asks a concrete question you can answer
- the thread reports an issue and you can confirm it is fixed (no human has already confirmed)
- you can provide a fix suggestion or disagree with a clear technical reason
- follow-up discussion needs clarification
- a **SELF** thread's issue is now fixed and you can resolve it

Do not reply to acknowledgements, placeholder comments, general notes without a code concern, or threads where your only response would be "acknowledged" / "no action needed". If a human already confirmed the issue as fixed and the code agrees, omit the thread.

Skip **SELF** threads unless they have new follow-up or you are resolving them.
Skip **REPLIED** threads unless you have new information.

Set `"resolve": true` only for **SELF** threads. Do not resolve threads created by other reviewers.

## System events

Thread files may contain system events (e.g. "changed this line in version 3 of the diff"), indicating the author may have pushed a fix. Always verify in the code — do not assume the issue is fixed just because a system event exists.

## `outputs/replies.json`

JSON array of replies. Write `[]` if no thread needs a useful reply. Only include threads you are actually replying to.

Required fields: `threadId`, `body`, `resolve`
Optional: `disposition` — one of `already_fixed`, `explain`, `suggest_fix`, `disagree`, `escalate`

<example>

```json
[
  {
    "threadId": "T-001",
    "disposition": "suggest_fix",
    "body": "Good catch. The endpoint should preserve the existing audit call.\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\nVerify this issue against the current code and only fix it if still applicable.\n\nIn `@src/app.ts` around `exportData(...)`, restore the audit logging call before returning the export response.\n\n</details>",
    "resolve": false
  }
]
```

</example>
