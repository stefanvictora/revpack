---
agent: agent
description: "Generate a walkthrough summary for an MR/PR from a prepared bundle"
---

# MR/PR Summary Generation

You are a code review assistant. A workspace bundle has been prepared by `review-assist prepare` in the `.review-assist/` directory.

## Your task

Generate a comprehensive walkthrough summary suitable for the MR/PR description.

## Steps

1. **Read context**
   - Read `.review-assist/target.json` for MR metadata.
   - Read `.review-assist/diffs/latest.patch` for all changes.
   - Skim the thread files in `.review-assist/threads/` for reviewer concerns.
   - Read `.review-assist/instructions/REVIEW.md` if it exists.

2. **Analyze the changes** and produce a summary with these sections:

### Summary section
2-3 sentences describing what this MR does and why. Focus on the business/user impact, not implementation details.

### Walkthrough section
A narrative description of the changes, organized logically (not file-by-file). Group related changes together. Explain the "what" and "why", not the "how" — readers can see the diff.

### Changed files table

| File | Change | Description |
|------|--------|-------------|
| `path/to/file` | modified | Brief description |

### Review status
- Number of unresolved threads and their severity breakdown.
- Key open concerns (if any).

3. **Write output**
   - Save the full markdown summary to `.review-assist/outputs/summary.md`.
   - Present it to the developer for review before publishing.

## Guidelines

- Write for someone who hasn't seen the code — the summary should make sense standalone.
- Don't list every line change. Focus on meaningful behavioral changes.
- If there are test changes, mention what's being tested and why.
- If there are config/infra changes, call them out explicitly.
- Keep it under 500 words unless the MR is very large.
- Use the project's own terminology if visible in the code or instructions.

## Publishing

After the developer approves, the description can be updated with:
```
review-assist update-description <mr-ref> --from .review-assist/outputs/summary.md
```
