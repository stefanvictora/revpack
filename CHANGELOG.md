# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Added first-class Bitbucket Cloud support across configuration, checkout, bundle preparation, status, discussions, and publishing.
- Added Guided Publish: running bare `revpack publish` in a supported terminal now lets you preview and select draft findings, replies, and review notes before confirming. Deferred drafts are preserved, stale bundles must be refreshed, and explicit publish subcommands remain non-interactive for scripts and CI.
- Added `revpack auth setup`, `revpack auth doctor`, and `revpack auth show`, plus top-level `revpack doctor`, for guided provider authentication and diagnostics.
- Added `revpack setup --agent <target>` for one-step project and agent setup. It installs `revpack-review` plus the new `revpack-context` adapter, which lets agents inspect changes, discuss or address review threads, and draft replies without starting a formal review.
- Prepared bundles now include commit messages when available and keep active and resolved review threads as separate context.

### Changed

- **Upgrade action — recreate generated agent skills and adapters.** Review bundles now use per-file Anchor Maps instead of `.revpack/diffs/line-map.ndjson` and `change-blocks.json`. Existing generated instructions that reference those removed files will not work with new bundles; delete them and run `revpack setup agent <target>` after upgrading.
- Agent setup now installs both `revpack-review` and `revpack-context`. Future setup runs automatically refresh unmodified generated adapters, preserve customized adapters, and offer `--force` when you intentionally want to replace customizations.
- Review notes now use `revpack publish note` and `.revpack/outputs/note.md`. `revpack publish review` remains as a compatibility alias but does not publish legacy `.revpack/outputs/review.md` drafts.
- Prepared bundles now have a clearer task and file layout: `.revpack/CONTEXT.md` is the neutral entry point, review-only instructions are loaded only for formal reviews, schemas are separate from agent drafts, and output files exist only when there is pending material.
- `revpack config` now shows profile-oriented help. Authentication setup validates and normalizes provider URLs earlier, infers providers when possible, and detects existing token environment variables.
- `revpack publish findings` now accepts any non-empty category while continuing to recommend the standard categories.

### Fixed

- Prepared bundles no longer expose the absolute local repository path or retain stale per-file patches after repeated preparation.
- GitLab checkout now handles deleted MR source branches, including forked repositories and later bundle commands from the fallback branch.
- `revpack status` now reports remote target state, authentication failures, and ahead-of-head guidance accurately.
- Publishing no longer republishes completed review notes or summaries, preserves pending replies to resolved threads, and handles partial failures and checkpoints more safely.
- Generated suggestions now use the correct provider-specific Markdown syntax.
- Windows provider errors no longer end with an unrelated libuv assertion, and debug logging no longer repeats the user-facing error.

## [0.4.0] - 2026-06-07

### Added

- Added agent harness setup for Claude, Codex, Cursor, and GitHub Copilot via `revpack setup agent <target>`.

### Changed

- Changed `revpack checkout` to prepare the review bundle by default, so checkout now leaves the review context ready to use.
- Improved incremental review instructions so agents focus on newly changed code and threads while still allowing important findings outside the incremental diff.
- Improved `revpack status` output with clearer sections, better next-step guidance, and a stale bundle indicator when the prepared bundle no longer matches the latest PR/MR head.
- Improved publish command output and follow-up guidance.
- Reworked README and command documentation for the current setup and review workflows.

### Fixed

- Improved checkout support on Windows by automatically using `core.longpaths=true` for git commands.
- Fixed resolved threads appearing in the incremental "changed threads since last checkpoint" context section.
- Fixed GitHub bot-user detection so bot comments are not incorrectly treated as human review comments or findings.
- Fixed unresolved thread flags so comments from other bots such as CodeRabbit are not labeled as revpack `SELF` threads.

### Deprecated

- Deprecated `revpack setup --prompts`. Use `revpack setup agent copilot` for the Copilot prompt.
- Deprecated `revpack checkout --prepare`. Checkout prepares by default now, and the flag is kept only for compatibility.

## [0.3.1] - 2026-05-20

### Changed

- Improved summary instructions so agents write more focused, concise summaries that emphasize behavior changes instead of listing every implementation detail.

### Fixed

- Fixed stale replies being removed when running individual publish commands.

## [0.3.0] - 2026-05-16

### Added

- Added command reference documentation and a basic review example bundle.

### Changed

- Improved the instruction layout and progressive reading order for review agents.
- Reduced the amount of required instruction reading for incremental modes, so agents can focus on the instructions relevant to the current review state.
- Improved CLI readability and status messaging.
- Refreshed README structure and supporting documentation.

## [0.2.0] - 2026-05-15

### Added

- Added initial support for local review bundles without an active PR/MR via `revpack prepare --local`.

### Changed

- Improved readability of CLI output across prepare, checkout, status, publish, config, and clean commands.
- Improved local git handling for local bundle preparation.

## [0.1.1] - 2026-05-14

### Changed

- Simplified the README.
- Moved benchmark export details into separate script documentation.

### Fixed

- Fixed installation instructions in the README.

## [0.1.0] - 2026-05-14

### Added

- Initial release of `revpack`.
- Added structured local review bundles for AI-assisted PR/MR review.
- Added provider support for GitHub and GitLab.
- Added commands for preparing review bundles, checking out review targets, publishing review outputs, managing configuration, checking status, and cleaning local bundle state.
- Added incremental review state tracking, including changed-code and changed-thread context.
- Added support for local git diffs, per-file patch outputs, review summaries, review notes, thread replies, and new findings.
- Added project setup support for review guidelines and the initial Copilot review prompt.
