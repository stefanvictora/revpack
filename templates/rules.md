# Project Review Rules

<!-- Uncomment and adapt the sections relevant to your project. -->

## Stack & conventions

<!-- Describe your tech stack so the reviewer agent has context.
- Language: Java 21 / TypeScript 5 / Python 3.12
- Framework: Spring Boot 3.x / Next.js 14 / FastAPI
- Build: Maven / npm / Poetry
- Test framework: JUnit 5 / Vitest / pytest
- Linter/formatter: Checkstyle / ESLint+Prettier / Ruff
-->

## Known patterns

<!-- Document patterns specific to your codebase.
- We use the Repository pattern for all DB access. Don't access JPA entities directly from controllers.
- All API endpoints must go through the `AuthMiddleware`.
- Feature flags are managed via `FeatureToggleService` — never use environment variables for feature gating.
- DTOs and entities are in separate packages. Don't expose entities in API responses.
-->

## Common false positives

<!-- List things that review tools or reviewers frequently flag but are intentional.
- The `@SuppressWarnings("unchecked")` in GenericDao is intentional — the cast is safe due to type erasure.
- Empty catch blocks in EventBus handlers are intentional — events are best-effort.
- The Thread.sleep() in RetryHelper is intentional, not a test smell.
-->

## Testing expectations

<!-- What level of testing do you expect for MRs?
- New business logic must have unit tests.
- API endpoint changes need integration tests.
- Bug fixes should include a regression test.
- UI changes: snapshot tests are optional, behavioral tests are preferred.
-->

## Security rules

<!-- Project-specific security policies.
- All user input must be validated using the `InputValidator` utility.
- SQL queries must use parameterized statements — no string concatenation.
- PII fields must be annotated with `@Sensitive` for audit logging.
- No secrets in code, config files, or test fixtures. Use the vault.
-->

## Review scope exclusions

<!-- Files or patterns that agents should skip or treat leniently.
- Generated files in `src/generated/` — don't review these.
- Migration files in `db/migrations/` — review for correctness but not style.
- `package-lock.json` / `pom.xml` dependency changes — just check for known vulnerabilities.
-->
