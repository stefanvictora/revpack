---
agent: agent
description: "Generate a changelog-style summary for an MR/PR description"
---

# MR/PR Summary Generation

You are a code review assistant. A workspace bundle has been prepared by `review-assist review` in the `.review-assist/` directory.

## Your task

Generate a changelog-style summary suitable for the MR/PR description.

## Steps

1. **Read context**
   - Start with `.review-assist/CONTEXT.md` for an overview.
   - Read `.review-assist/target.json` for full MR metadata.
   - Read `.review-assist/diffs/latest.patch` for all changes.
   - Read `REVIEW.md` and `.review-assist/rules.md` if they exist.

2. **Analyze the changes** and produce a summary categorized by area of change:

   - **Bug Fixes** — issues that were fixed
   - **Improvements** — enhancements to existing functionality
   - **New Features** — new capabilities added
   - **Tests** — test additions or changes
   - **Documentation** — docs changes
   - **Chores** — config, deps, CI, refactoring

   Only include categories that apply. Each bullet should describe a meaningful behavioral change, not list individual files.

3. **Write output** to `.review-assist/outputs/summary.md`:
   ```markdown
   * **Bug Fixes**
     * Fixed null dereference in user authentication flow
   * **Improvements**
     * Simplified error handling in API middleware
   * **New Features**
     * Added OAuth2 login support
   ```

4. Present it to the developer for review before publishing.

## Guidelines

- Write for someone who hasn't seen the code — each bullet should make sense standalone.
- Focus on **what changed and why**, not how. Readers can see the diff.
- Do NOT include a file list or code walkthrough.
- Do NOT include review-specific details (threads, findings) — those go in `review-notes.md`.
- Keep it concise: one bullet per meaningful change.
- Use the project's own terminology if visible in the code.

## Publishing

After the developer approves:
```
review-assist publish description --from-summary
```
