---
agent: agent
description: "Quick-prepare and review: fetch MR, address threads, and find new issues in one step"
---

# Quick Review

Prepare a review bundle and immediately start a full review — existing threads and proactive code review.

## Steps

1. Run in the terminal:
   ```
   review-assist review
   ```
   This auto-detects the MR from the current branch. If it fails, ask the user for a ref (`!42` or a URL) and run:
   ```
   review-assist review <ref>
   ```

2. Once the command completes, **read `.review-assist/CONTEXT.md`** — this is the entry point that describes everything in the bundle.

3. **Read review guidelines** (if they exist):
   - `REVIEW.md` in the repo root — project review priorities.
   - `.review-assist/rules.md` — specific rules and conventions.

4. **Address existing threads** (`.review-assist/threads/`):
   a. Read each `.md` thread file
   b. Check the actual source code at the referenced location
   c. Check `.review-assist/diffs/latest.patch` for context
   d. Decide: is this valid? already fixed? needs a code change? needs a reply?
   e. If a code fix is needed, make the change directly in the source file
   f. Draft a reply for the thread

5. **Proactive code review**:
   a. Read the full diff and the source files for each changed file
   b. Look for issues not raised by reviewers: bugs, security, performance, logic errors
   c. For trivial issues, fix the code directly
   d. For non-trivial issues, add entries to `outputs/new-findings.json`

6. **Write output files** (critical — always do this):
   - `outputs/replies.json` — replies to existing threads, using **T-NNN** short IDs:
     ```json
     [
       { "threadId": "T-001", "body": "Fixed, good catch!", "resolve": true }
     ]
     ```
   - `outputs/new-findings.json` — new issues found during proactive review:
     ```json
     [
       { "filePath": "src/app.ts", "line": 42, "body": "Potential null dereference", "severity": "high", "category": "correctness" }
     ]
     ```
   - `outputs/summary.md` — walkthrough summary for the MR description.

7. Present a summary table to the developer showing each thread and finding with your assessment.

8. Ask the developer which results to publish, then run:
   ```
   review-assist publish-reply            # publish thread replies
   review-assist publish-finding          # publish new findings as MR threads
   review-assist update-description --from-summary
   ```
