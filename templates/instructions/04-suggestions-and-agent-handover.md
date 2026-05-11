# Suggestions and agent handover prompts

## Suggestion blocks

Prefer including a Markdown suggestion block when the core fix is a small, directly applicable change to lines visible in the diff and the target provider supports applying suggestions from review comments.

If provider support is unknown or the suggestion syntax would not be applied correctly, use a plain suggested fix instead.

Use a suggestion block when all of these are true:

- the replacement is complete for the local changed lines
- the changed lines are visible in `.revkit/diffs/line-map.ndjson`
- the suggestion is likely to compile
- the suggestion does not require unrelated edits in the same block
- the suggestion is easier for the developer to apply than rewriting the code manually

A fix may still need tests, imports, or follow-up changes elsewhere. That does not automatically disqualify a suggestion block.

If the main code fix is local but additional work is needed, include both:

1. a suggestion block for the directly applicable local code change
2. an agent handover prompt describing the remaining work, such as tests or related updates

Do not use suggestion blocks for:

- pseudocode
- incomplete fragments
- changes where the shown replacement alone would clearly not compile
- large rewrites
- changes requiring edits in multiple unrelated locations where a single local suggestion would be misleading
- fixes you are not confident about

For most findings, use:

````markdown
```suggestion:-0+0
replacement for the anchored line
```
````

Use wider ranges only when the replacement really needs neighboring lines.

## Positional anchor vs suggestion range

Do not confuse the finding anchor with the suggestion block range.

The finding anchor chooses where the review thread appears:

```json
{
  "newLine": 42
}
```

The suggestion block range chooses which lines around that anchor are replaced:

````markdown
```suggestion:-1+2
replacement code
```
````

The suggestion offsets are relative to the anchored line.

## Agent handover prompts

Agent handover prompts are complementary to suggestion blocks.

Include an agent handover prompt when the fix is clear and a developer may want an AI coding agent to implement the full change.

A handover prompt is especially useful for:

- findings that require edits in multiple places
- fixes that require adding or updating tests
- fixes that may need imports, method signature changes, or refactoring
- replies where an existing thread asks for a change and the fix is more than a small one-line suggestion
- cases where a suggestion block would be too large or fragile

If a small local code suggestion is possible, include it even when you also include a handover prompt.

Good pattern:

1. Explain the issue in the finding or reply.
2. Provide a small suggestion block for the direct local fix, if safely applicable.
3. Add a handover prompt for tests, imports, related changes, or broader cleanup.

### Write for a fixing agent with limited context

Write handover prompts for a fixing agent that may only see the current workspace.

Avoid relying on hidden review context. Do not say “restore the removed code”, “use the original implementation”, “revert this change”, or “add back the previous call” unless you also describe the desired final behavior or include the exact code/pattern to restore.

Prefer behavior-oriented wording:

- “Ensure successful exports emit DSG audit logging before the file response is written.”
- “Persist DMS containers for every successful submission with at least one registration.”
- “Return a dynamic selectable year range instead of the placeholder value `0`.”

When exact parameters or conventions matter, tell the fixing agent where to derive them:

- “Follow the existing DSG logging conventions in this controller.”
- “Use the same response handling pattern as the adjacent endpoint.”
- “Preserve the existing validation and error handling behavior.”

### Format

Use this format:

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

- Reference file paths with an `@` prefix, for example `@src/path/to/File.java`.
- Include line numbers, method names, class names, or other stable context so the fixing agent can locate the code.
- Describe the desired final behavior, not only the suspected cause.
- Describe what behavior should be preserved when the fix touches validation, authorization, persistence, API responses, logging, or error handling.
- Mention tests when the fix should include a regression test.
- Keep the prompt self-contained. The fixing agent may not see the review thread, MR/PR diff, or previous implementation.
- Keep it concise. A good handover prompt usually has one location sentence, one behavior sentence, one preservation sentence if needed, and one test sentence.

---
