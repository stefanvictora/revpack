---
agent: agent
description: "Quick-prepare and review: fetch MR threads and start review in one step"
---

# Quick Review

Prepare a review bundle and immediately start processing threads.

## Steps

1. Ask which MR/PR to review if not obvious from context. The user may provide:
   - A number like `!896`
   - A full GitLab/GitHub URL
   - "current branch" (derive from git)

2. Run in the terminal:
   ```
   review-assist review <ref> --repo <repo>
   ```
   If the repo is not known, check `review-assist config show` or ask.

3. Once the command completes, **read `.review-assist/CONTEXT.md`** — this is the entry point that describes everything in the bundle.

4. Read the review instructions in `.review-assist/instructions/` if present.

5. For each unresolved thread (read the `.md` files in `.review-assist/threads/`):
   a. Read the reviewer's comment
   b. Check the actual source code at the referenced location
   c. Check `.review-assist/diffs/latest.patch` for context
   d. Decide: is this valid? already fixed? needs a code change? needs a reply?
   e. If a code fix is needed, make the change in the source file
   f. Draft a reply for the thread

6. **Write output files** (this is critical):
   - Save reply drafts to `.review-assist/outputs/replies.json` using **T-NNN** short IDs:
     ```json
     [
       { "threadId": "T-001", "body": "Fixed, good catch!", "resolve": true },
       { "threadId": "T-002", "body": "Acknowledged.", "resolve": false }
     ]
     ```
   - Save or update `.review-assist/outputs/summary.md` with a walkthrough summary.

7. Present a summary table to the developer showing each thread, your assessment, and proposed action.

8. Ask the developer which replies to publish, then run:
   ```
   review-assist publish-reply          # publish all
   review-assist publish-reply T-001    # publish one
   ```
