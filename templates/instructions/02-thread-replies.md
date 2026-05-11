# Thread replies

Use `.revkit/threads/` and the unresolved thread overview in `.revkit/CONTEXT.md`.

`outputs/replies.json` must contain only replies that should actually be posted back to the MR/PR.

Do not include entries for threads you decided to ignore.

An unresolved thread does not require a reply just because it is unresolved.

Only write a reply when the reply adds useful information for another human reviewer or author.

Write a reply only when one of these is true:

- the thread asks a concrete question and you can answer it
- the thread reports a concrete issue, no human has already confirmed it as fixed/addressed, and you can confirm it is fixed
- the thread reports a concrete issue and you can provide a fix suggestion
- the thread reports a concrete issue and you disagree with a clear technical reason
- the thread has follow-up discussion that needs clarification
- the thread was created by revkit (**SELF**) and you can resolve it because the issue is now fixed

Do not reply to:

- test comments
- placeholder comments
- acknowledgements
- comments without a concrete code concern
- general notes that do not require an answer
- threads where your only response would be “acknowledged”, “no action needed”, “nothing to do”, or “no code change suggested”
- threads where a human already confirmed the issue was fixed/addressed and the current code agrees
  - Human comments such as “fixed”, “done”, “removed”, “addressed”, “changed”, “resolved”, or equivalent wording count as human confirmation.

For those cases, omit the thread from `outputs/replies.json`.

Skip threads marked **SELF** unless they have new follow-up from others or you are resolving your own previously published finding.

Skip threads marked **REPLIED** unless you have new information to add.

Set `"resolve": true` only for threads you created yourself (**SELF** threads). Do not resolve threads created by other reviewers.

## System events in threads

Thread files in `.revkit/threads/` may contain **system events** (e.g. "changed this line in version 3 of the diff").

These events indicate that the MR/PR author may have pushed changes that address the feedback in the thread, even if no comment was left.

When you see a system event in a thread:

1. Check the current source code to see if the issue was actually fixed.
2. If the issue is fixed, you may resolve the thread (if it is a **SELF** thread) or note that it appears fixed.
3. Do not assume the issue is fixed just because a system event exists — verify in the code.

## `outputs/replies.json`

Write replies to existing threads as a JSON array.

If no existing thread needs a useful reply, write:

```json
[]
```

Example:

```json
[
  {
    "threadId": "T-001",
    "disposition": "suggest_fix",
    "body": "Good catch. The endpoint should preserve the existing audit call.\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\nVerify this issue against the current code and only fix it if still applicable.\n\nIn `@src/app.ts` around `exportData(...)`, restore the audit logging call before returning the export response. Add or update a regression test that verifies the audit service is called for successful exports.\n\n</details>",
    "resolve": false
  }
]
```

Required fields:

- `threadId`
- `body`
- `resolve`

Optional but recommended:

- `disposition`

Allowed dispositions:

- `already_fixed`
- `explain`
- `suggest_fix`
- `disagree`
- `escalate`

If the reply does not add technical value, omit it.
