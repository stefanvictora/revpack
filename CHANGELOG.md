# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Prepared GitHub review threads now preserve multi-line Code Spans. Thread Markdown and Guided Publish code excerpts use clearer selection gutters, symmetric context that stays within one diff hunk, visible condensation for long spans, and width-safe terminal clipping.

### Changed

- Formal revpack reviews now use a lightweight internal Risk Inventory to focus effort on higher-impact areas, trace intended behavior and required follow-through, validate concerns against surrounding evidence, and discard candidate findings that do not survive an active attempt to disprove them.
- Default Review Guidance now includes a concise simplicity lens for disproportionate complexity with concrete maintenance or correctness risk.
- Review findings now prefer `reliability`, `compatibility`, and `observability` categories while continuing to accept custom categories.

### Fixed

- Guided Publish Markdown previews now style inline code containing underscores correctly inside bold or italic emphasis.

## [0.5.0] - 2026-07-27

### Added

- Added first-class Bitbucket Cloud support for authentication, configuration, checkout, bundle preparation, status, review threads, and publishing.
- Added **Guided Publish**. Running `revpack publish` without a subcommand in a supported terminal now opens an interactive flow for previewing and selecting draft findings, replies, and notes before publishing. Deferred drafts remain available, stale bundles must be refreshed, and explicit publish subcommands remain non-interactive for scripts and CI.
- Added `revpack auth setup`, `revpack auth doctor`, and `revpack auth show` for guided provider authentication and diagnostics. The new top-level `revpack doctor` command provides direct access to configuration and authentication checks.
- Added `revpack setup --agent <target>` for one-step project and agent setup. It installs:
  - `revpack-review` for formal code reviews
  - `revpack-context` for inspecting changes, working through review threads, and drafting replies without starting a formal review

- Prepared bundles now include commit messages when available and provide active and resolved review threads as separate context.

### Changed

- **Upgrade action: refresh generated agent skills and adapters.** Review bundles now use per-file Anchor Maps instead of `.revpack/diffs/line-map.ndjson` and `.revpack/diffs/change-blocks.json`. After upgrading, run:

  ```sh
  revpack setup agent <target>
  ```

  Unmodified generated skills and adapters are migrated automatically, while customized files are preserved. Use `--force` only when you intentionally want to replace local customizations. Setup now installs or updates both `revpack-review` and `revpack-context`.

- Review notes now use `revpack publish note` and `.revpack/outputs/note.md`. `revpack publish review` remains available as a compatibility alias, but legacy `.revpack/outputs/review.md` drafts are no longer published.

- Prepared bundles now use a clearer, task-oriented structure:
  - `.revpack/CONTEXT.md` is the neutral entry point.
  - Review-specific instructions are loaded only for formal reviews.
  - Schemas are stored separately from agent drafts.
  - Output files are created only when they contain pending material.

- `revpack config` now presents profile-oriented help. Authentication setup also validates and normalizes provider URLs earlier, infers the provider where possible, and detects existing token environment variables.

- `revpack publish findings` now accepts any non-empty category while continuing to recommend the standard categories.

### Fixed

- Prepared bundles no longer expose the absolute local repository path or retain stale per-file patches after repeated preparation.
- GitLab checkout now supports deleted MR source branches, including MRs from forked repositories and subsequent bundle commands run from the fallback branch.
- `revpack status` now reports remote target state and authentication failures more accurately, and provides correct guidance when the local branch is ahead of the remote target.
- Publishing no longer republishes completed notes or summaries. It also preserves pending replies when threads are resolved and handles partial failures and checkpoints more safely.
- Generated suggestions now use the correct provider-specific Markdown syntax.
- Provider errors on Windows no longer end with an unrelated libuv assertion, and debug logging no longer duplicates the user-facing error.

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
