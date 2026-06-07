# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
