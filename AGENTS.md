# Agent instructions

## Repository development

This is a TypeScript ESM CLI project. Prefer small, focused changes that follow the existing `src/<area>/*.ts` plus colocated `*.test.ts` pattern.

Respect the layers:

- `src/core/`: provider-neutral types, schemas, and errors
- `src/providers/`: GitHub, GitLab, and local adapters
- `src/workspace/`: git operations and bundle creation
- `src/orchestration/`: workflow coordination
- `src/cli/`: Commander commands and CLI output

Keep logic in the layer that owns it. Do not push provider-specific behavior into `core`, CLI formatting into orchestration, or workflow coordination into providers.

Use npm. Do not introduce another package manager or update lockfiles unless dependency changes require it.

Prefer user-visible correctness over internal reshuffling. Avoid broad refactors unless requested or needed for a safe, clear fix.

## Priorities

Prioritize:

1. Correctness and changed behavior
2. Security, tokens, credentials, permissions, and unsafe publishing behavior
3. Reliability around git, provider APIs, filesystem writes, retries, partial failure, and cleanup
4. Compatibility of CLI behavior, flags, config, generated files, schemas, and output formats
5. Tests for meaningful behavior and regressions
6. Maintainability when structure, naming, or duplication creates real future risk

Avoid style-only edits, formatting churn, and speculative improvements.

## Verification

Choose the lightest check that covers the change. On PowerShell, use `npm.cmd` instead of `npm` if needed.

- TypeScript or test changes: `npm run typecheck`
- Behavior changes: targeted Vitest tests when possible, otherwise `npm test`
- Production code, CLI behavior, exports, packaging, or generated package contents: `npm run build`
- Style-sensitive TypeScript or import changes: `npm run lint`

`npm run build` intentionally excludes tests; use `npm run typecheck` to catch test type errors.

Do not run slow or broad verification when a targeted command covers the change.

## Changelog

`CHANGELOG.md` is user-facing. Follow its existing structure and category headings.

Update `[Unreleased]` for user-visible changes: commands, flags, behavior, compatibility, setup, meaningful fixes, workflow documentation, or deprecations.

`[Unreleased]` is an editable draft, not an append-only log. Add, merge, reword, move, or remove entries to keep the release note compact and coherent.

Do not edit released sections except for clear typos or formatting mistakes. Skip internal refactors, test-only changes, formatting, small wording tweaks, and maintenance with no visible user effect.

## Mutation testing

Mutation testing is useful but slow. Do not run the full suite by default.

Use focused mutation runs when strengthening tests around changed behavior, validators, conditionals, formatting, command output, schema handling, or bug fixes:

```powershell
npm.cmd run test:mutation:file -- src/path/to/file.ts
npm.cmd run test:mutation:dry
```

Inspect `reports/mutation/mutation.json`, group surviving or uncovered mutants by behavior, add user-observable assertions, then rerun the same focused command.

## Extra guardrails

- For CLI changes, consider both human-readable output and `--json` output. Update tests, README/docs, and `CHANGELOG.md` when workflows change.
- Keep filesystem and path handling cross-platform. Prefer Node path utilities over hard-coded `/` or `\` separators.
- Never print, snapshot, or commit provider tokens, resolved credentials, or secret environment variable values. Redact secrets in errors, logs, tests, and fixtures.
- When changing generated files or agent setup output, update the source template or generator and its tests rather than editing generated output directly.
- Source files are UTF-8 and may contain Unicode CLI symbols such as `✓`, `→`, and `─`. Preserve them unless the task explicitly changes output text.
- Do not treat mojibake in terminal output as file content; PowerShell may display UTF-8 incorrectly. Prefer editing by ASCII anchors such as function names, variable names, and nearby TypeScript structure.
- Avoid broad rewrites around Unicode-heavy output blocks. Use small patches, or read/write with explicit UTF-8 handling when scripting edits.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `stefanvictora/revpack`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default mattpocock/skills triage labels unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: use root `CONTEXT.md` and root `docs/adr/` when present. See `docs/agents/domain.md`.
