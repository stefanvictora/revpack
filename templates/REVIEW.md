# Review Guidelines

## Code review priorities (in order)

1. **Correctness** — Does it do what it's supposed to? Edge cases handled?
2. **Security** — Input validation, auth checks, injection risks, secrets exposure.
3. **Reliability** — Error handling, null safety, resource cleanup, concurrency.
4. **Performance** — Only when there's a measurable concern. Don't micro-optimize.
5. **Maintainability** — Naming, structure, reasonable complexity.
6. **Style** — Defer to the formatter/linter. Don't block MRs on style.

## What to flag

- Missing error handling at system boundaries (API calls, DB queries, file I/O).
- Unchecked nulls on data from external sources.
- Security: unsanitized user input, missing auth checks, hardcoded secrets.
- Logic errors: off-by-one, wrong operator, inverted condition.
- Missing or broken tests for new behavior.
- Breaking changes to public APIs without migration path.

## Repository conventions and local patterns

When reviewing changed code, compare it with nearby existing code and established repository patterns.

Consider whether the change follows existing conventions for:

- package/module boundaries and layering
- naming of classes, methods, DTOs, services, tests, and exceptions
- validation, authorization, error handling, logging, and auditing
- transaction boundaries, persistence patterns, and external-service calls
- test structure, fixture setup, assertions, and naming
- API response shapes, error messages, serialization, and compatibility behavior

Prefer existing repository conventions unless they are clearly harmful or conflict with explicit project standards.

Flag convention deviations only when they create a concrete readability, maintainability, correctness, compatibility, or onboarding risk.

Do not flag purely mechanical style issues that are already handled by formatter, linter, or CI.

## What NOT to flag

- Style issues already covered by linter/formatter.
- "I would have done it differently" without a concrete problem.
- Missing docs on internal/private code.
- Theoretical performance issues without evidence of impact.
- Deviations from existing style that are purely mechanical and already covered by formatter, linter, or CI.
- Cleaner local improvements that differ from old code but do not create inconsistency, risk, or confusion.

## Reply tone

- Be direct and specific. Say what the problem is and where.
- If suggesting a fix, show code.
- If it's a nit, prefix with "nit:" so the author knows it's non-blocking.
- If asking a question, make it clear you're asking, not requesting a change.
- Acknowledge good patterns when you see them — reviews aren't only for criticism.

## Severity definitions

| Severity | Meaning                                              | Blocks merge? |
| -------- | ---------------------------------------------------- | ------------- |
| blocker  | Must fix. Security issue, data loss, crash.          | Yes           |
| high     | Should fix. Bug, incorrect behavior.                 | Usually       |
| medium   | Consider fixing. Potential issue, missing edge case. | No            |
| low      | Minor improvement.                                   | No            |
| nit      | Style/preference. Take it or leave it.               | No            |
