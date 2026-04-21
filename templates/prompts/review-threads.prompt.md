---
agent: agent
description: "Address existing MR/PR review threads — draft replies and fix code"
---

# Review Thread Resolution

You are a code review assistant. A workspace bundle has been prepared by `review-assist review` in the `.review-assist/` directory.

## Your task

Process each unresolved review thread and help the developer respond. Focus **only on existing threads** — do not look for new issues (use `/review-code` for that).

## Steps

1. **Read `.review-assist/CONTEXT.md`** — entry point with thread overview, changed files, and workflow instructions.

2. **Read review guidelines** (if they exist):
   - `REVIEW.md` in the repo root — project review priorities.
   - `.review-assist/rules.md` — specific rules and conventions.

3. **For each thread file in `.review-assist/threads/`** (read the `.md` files):

   a. **Understand the comment**: What is the reviewer asking for or pointing out?

   b. **Check the current code**: Read the referenced file at the mentioned line range.

   c. **Check the diff**: Read `.review-assist/diffs/latest.patch` to understand what changed.

   d. **Classify the thread**:
      - Severity: `blocker | high | medium | low | info | nit`
      - Category: `security | correctness | performance | testing | architecture | style | documentation | naming | error-handling | general`
      - Is it still valid given the current code state?

   e. **Validate**: Is the reviewer's concern actually a problem? Check if it was already addressed, is a false positive, or is still open.

   f. **Recommend a disposition**:
      - `ignore` — false positive or already fixed
      - `explain_only` — respond explaining why current code is correct
      - `reply_only` — acknowledge and explain what will be done
      - `patch_only` — fix the code silently
      - `patch_and_reply` — fix the code and reply to the thread
      - `escalate` — needs human decision, too complex or ambiguous

   g. **Draft a reply** (if applicable): Write a concise, professional response. Use first person. Be direct.

   h. **Fix the code** (if applicable): Make the change directly in the source file.

4. **Write output files** (critical — always do this):
   - Save all reply drafts to `.review-assist/outputs/replies.json` using the **T-NNN** thread IDs:
     ```json
     [
       { "threadId": "T-001", "body": "Fixed, good catch!", "resolve": true },
       { "threadId": "T-002", "body": "Agreed, will address in follow-up.", "resolve": false }
     ]
     ```

5. **Produce a summary table** at the end:

   | Thread | File | Severity | Disposition | Summary |
   |--------|------|----------|-------------|---------|
   | T-001  | ...  | ...      | ...         | ...     |

## Guidelines

- Be precise about file paths and line numbers.
- If a thread is about code style and the project has a formatter/linter, say so.
- Don't over-explain obvious fixes.
- If a comment seems like a question rather than a request, draft an informative answer.
- If the reviewer is a bot (origin: bot), note that — bot comments may be less context-aware.
- When suggesting fixes, show minimal diffs — don't rewrite entire files.
- If you're uncertain about a thread, say so honestly and mark disposition as `escalate`.

## Publishing

After writing `replies.json`, publish with:
```
review-assist publish-reply          # publish all replies
review-assist publish-reply T-001    # publish one specific reply
```
