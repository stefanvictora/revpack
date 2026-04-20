---
agent: agent
description: "Quick-prepare and review: fetch MR threads and start review in one step"
---

# Quick Review

Prepare a review bundle and immediately start processing threads.

## Steps

1. Ask which MR/PR to review if not obvious from context. The user may provide:
   - A number like `!896`
   - A full URL
   - "current branch" (derive from git)

2. Run in the terminal:
   ```
   review-assist prepare <ref> --repo <repo>
   ```
   If the repo is not known, check `review-assist config show` or ask.

3. Once the bundle is prepared, follow the **review-threads** workflow:
   - Read each thread in `.review-assist/threads/`
   - Validate against current code
   - Classify severity and disposition
   - Draft replies
   - Present summary table

4. Ask the developer which replies to publish.
