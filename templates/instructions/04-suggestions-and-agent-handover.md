# Suggestions and agent handover prompts

## Suggestion blocks

Include a Markdown suggestion block when the fix is a small, directly applicable change to lines visible in `line-map.ndjson`.

Use a suggestion block when:

- the replacement is complete for the local changed lines
- the suggestion is likely to compile
- it does not require unrelated edits in the same block

Do not use suggestion blocks for pseudocode, incomplete fragments, large rewrites, changes across multiple unrelated locations, or fixes you are not confident about.

A fix may still need tests, imports, or follow-up elsewhere — that does not disqualify a suggestion block. Include both a suggestion block for the local fix and a handover prompt for remaining work.

Default syntax — replaces only the anchored line:

````markdown
```suggestion:-0+0
replacement for the anchored line
```
````

Use wider ranges only when the replacement needs neighboring lines.

### Anchor vs suggestion range

The finding anchor (`newLine: 42`) controls where the thread appears. The suggestion range (`-1+2`) controls which lines around that anchor are replaced. Do not confuse them.

## Agent handover prompts

Include a handover prompt when the fix is clear and a developer may want an AI coding agent to implement it. Especially useful for multi-file edits, test additions, or fixes too large for a suggestion block.

### Writing effective handover prompts

The fixing agent may only see the current workspace — not the review thread, diff, or previous code. Write self-contained prompts that describe the desired final behavior, not just the suspected cause.

Prefer behavior-oriented wording:

- "Ensure successful exports emit audit logging before the response is written."
- "Return a dynamic selectable year range instead of the placeholder value `0`."

When conventions matter, point the agent to examples: "Follow the existing logging conventions in this controller."

### Format

```md
<details>
<summary>🤖 Prompt for AI Agents</summary>

Verify this issue against the current code and only fix it if still applicable.

In `@src/path/to/File.java` around `methodName(...)`, change the current behavior so that [desired behavior].

Preserve [important existing behavior, if relevant].

Add or update tests covering [specific scenario].

</details>
```

### Rules

- Reference file paths with `@` prefix (e.g. `@src/path/to/File.java`).
- Include line numbers, method names, or class names for location.
- Describe the desired final behavior and what should be preserved.
- Mention tests when the fix should include a regression test.
- Keep it concise: typically one location sentence, one behavior sentence, one preservation sentence, one test sentence.

---
