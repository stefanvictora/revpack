# Review Guidelines

## Code review priorities

Review in this priority order:

1. **Correctness** — Does the change preserve intended behavior? Are edge cases handled?
2. **Security** — Authorization, authentication, input validation, injection risks, secrets, sensitive data, and audit-relevant behavior.
3. **Reliability** — Error handling, null safety, resource cleanup, concurrency, retries, timeouts, and partial failures.
4. **Compatibility** — Public APIs, CLI behavior, configuration, serialized data, persisted data, migrations, and backwards compatibility.
5. **Testing** — Meaningful coverage for new or changed behavior, especially risky behavior.
6. **Performance** — Only when there is a realistic or measurable concern. Do not micro-optimize.
7. **Maintainability** — Naming, structure, complexity, coupling, and consistency with local patterns.
8. **Style** — Defer to formatter, linter, and existing conventions. Do not block MRs on style alone.

## What to flag

Flag issues that are concrete, actionable, and relevant to the changed behavior.

Good findings include:

- Logic errors, inverted conditions, off-by-one errors, wrong defaults, or changed behavior that contradicts the intended feature.
- Missing or weakened authorization, validation, audit logging, or access checks.
- Missing error handling at system boundaries such as API calls, database access, file I/O, network calls, external services, and event streams.
- Unchecked nulls, empty values, duplicates, invalid inputs, or malformed data from external or user-controlled sources.
- Broken API, CLI, configuration, serialization, migration, or persistence compatibility.
- Race conditions, unsafe shared state, resource leaks, retry storms, timeout problems, or fragile concurrency behavior.
- Security: unsanitized user input, missing auth checks, hardcoded secrets.
- Missing or misleading tests for new behavior where a realistic regression would not otherwise be caught.
- Maintainability issues that create real future risk, such as duplicated business rules, unclear ownership boundaries, or inconsistent validation paths.

## Verification expectations

Before treating something as a project-relevant issue, verify the concern against the surrounding code and local conventions.

Ask:

- Is the problematic behavior actually reachable?
- Is it introduced, exposed, or made worse by the change?
- Is it prevented by nearby validation, caller behavior, framework behavior, existing guards, or provider-specific behavior?
- Does the suggested fix preserve existing validation, authorization, persistence, API responses, logging, audit behavior, and error handling?
- Can the impact be explained concretely?
- If the concern is about missing tests, what specific behavior could regress?

Prefer no comment over a weak or speculative comment.

## Repository conventions and local patterns

When reviewing changed code, compare it with nearby existing code and established repository patterns.

Consider whether the change follows existing conventions for:

- package/module boundaries and layering
- naming of classes, methods, DTOs, services, tests, and exceptions
- validation, authorization, error handling, logging, and auditing
- transaction boundaries, persistence patterns, and external-service calls
- concurrency, caching, retry, timeout, and resource-cleanup patterns
- test structure, fixture setup, assertions, and naming
- API response shapes, error messages, serialization, and compatibility behavior
- CLI options, environment variables, configuration defaults, and documentation

Prefer existing repository conventions unless they are clearly harmful or conflict with explicit project standards.

Flag convention deviations only when they create a concrete readability, maintainability, correctness, compatibility, or onboarding risk.

## Always check when relevant

Pay particular attention to these areas when they are touched by the change:

- Changed public APIs, CLI options, configuration keys, environment variables, or persisted formats preserve compatibility or clearly document breaking changes.
- Authorization, validation, audit logging, and security-sensitive behavior are not accidentally bypassed.
- External-service calls handle failures, timeouts, retries, rate limits, and partial success.
- Persistence and migration changes preserve existing data and transaction behavior.
- Event-driven, cached, scheduled, or asynchronous logic remains safe under ordering, duplication, delay, and concurrency.
- User-visible behavior is reflected in documentation when the behavior is new or changed.
- Tests cover meaningful behavior rather than only implementation details.

## What not to flag

Do not flag:

- Formatting, import ordering, linting, or type-checking issues already handled by CI or project tooling.
- Pure style preferences without concrete readability or consistency impact.
- “I would have done it differently” comments without a real problem.
- Broad refactoring suggestions unrelated to the changed behavior.
- Theoretical performance issues without realistic impact.
- Missing documentation for internal/private code unless the lack of documentation makes changed behavior hard to use or maintain.
- Unrelated pre-existing problems.
- Generated files, vendored files, lockfiles, snapshots, and build artifacts unless they introduce a severe runtime, security, or compatibility risk.
- Test-only shortcuts unless they make the tests misleading, flaky, or unable to catch the intended regression.
- Cleaner local alternatives that differ from old code but do not create inconsistency, risk, or confusion.

## Pre-existing issues

Do not treat unrelated pre-existing issues as normal review findings.

If a pre-existing issue is important enough to mention, clearly mark it as pre-existing and avoid implying that the MR/PR author introduced it.

If the change exposes, worsens, or relies on a pre-existing issue, it is in scope. Explain how the changed behavior makes the issue relevant.

## Testing feedback

Flag missing or weak tests only when there is a concrete behavior risk.

Good testing feedback identifies:

- the changed behavior that needs coverage
- the scenario or edge case that could regress
- the kind of test that would catch it

Do not ask for tests merely because a file changed.

Prefer behavior-focused tests over tests that only mirror implementation details.

## Nits and low-priority feedback

Use nits rarely.

A nit should be:

- quick to understand
- cheap to fix
- clearly helpful
- not already enforced by tooling

Report at most three nits per review. If there are higher-severity issues, omit marginal nits.

Prefix nit comments with `nit:` so the author can treat them as optional.

## Reply tone

Be direct, specific, and respectful.

When reporting a problem:

- state what is wrong
- explain why it matters
- describe the condition under which it happens
- suggest a fix direction when possible

If suggesting a fix, prefer concrete code or precise behavior over vague advice.

If asking a question, make it clear whether it is a blocking concern or a clarification.

Acknowledge good patterns when they are relevant. Reviews are not only for criticism.

## Severity definitions

| Severity | Meaning                                                                                                                          | Blocks merge? |
|----------|----------------------------------------------------------------------------------------------------------------------------------|---------------|
| blocker  | Must fix. Breaks core functionality, causes data loss, or creates a serious security issue.                                      | Yes           |
| high     | Should fix. Likely production bug, security issue, broken API contract, or serious regression.                                   | Usually       |
| medium   | Consider fixing. Realistic edge case, missing coverage for risky behavior, or maintainability issue likely to cause future bugs. | No            |
| low      | Minor robustness, clarity, or maintainability improvement with limited risk.                                                     | No            |
| nit      | Cosmetic or preference-level issue. Use rarely.                                                                                  | No            |

Choose severity based on concrete impact, not on how suspicious the code looks.

If you cannot explain the impact, do not mark the issue as `high` or `blocker`.
