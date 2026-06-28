# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Added first-class Bitbucket Cloud profile configuration with `bitbucket-cloud`, `https://bitbucket.org`, `REVPACK_BITBUCKET_EMAIL`, and `REVPACK_BITBUCKET_TOKEN` defaults.
- Added Bitbucket Cloud pull request target resolution, branch auto-detection, metadata mapping, and `revpack status` display support.
- Added Bitbucket Cloud pull request checkout and prepare support using source branch/fork checkout plus local Git diff bundle generation.
- Added Bitbucket Cloud pull request comment mapping so prepared bundles include review threads, replies, inline positions, resolution state, and managed review note filtering.
- Added Bitbucket Cloud publishing for replies, thread resolution, inline findings, review notes, summary updates, checkpoints, and `revpack publish all`.

### Changed

- Relaxed finding category validation so `revpack publish findings` accepts any non-empty category while still recommending the standard category set.
- Changed bare `revpack config` to print profile-oriented help instead of acting as an alias for `revpack config show`, with clearer create, inspect/edit, and manage sections for profile workflows.

### Fixed

- Fixed generated review instructions so GitHub and local review bundles use plain suggestion fences while GitLab bundles keep range-offset suggestion fences.
- Fixed prepare after Bitbucket Cloud fork checkouts so missing base commits can be fetched from the base repository.
- Fixed Bitbucket Cloud prepare and status checks comparing abbreviated provider commit hashes against full local Git SHAs.
- Fixed Bitbucket Cloud prepare after shallow checkout so pull request commit hashes are expanded before bundle generation and missing commits are recovered through branch fetches instead of noisy direct SHA fetches.
- Fixed Bitbucket Cloud prepare so pending draft review comments and replies are excluded from review bundles.
- Improved `revpack config setup` prompts so provider URLs are entered before provider selection, invalid URLs fail immediately, provider URLs are stored as HTTP(S) origins, GitHub Enterprise-style hosts can be inferred from the URL, existing token environment variables are detected after creation, and invalid provider choices fail before later prompts.
- Fixed GitLab fallback checkout for deleted MR source branches, including follow-up bundle commands run from the fallback branch and fork fallback fetches.
- Fixed review summary instructions so incremental MR/PR updates keep newly introduced capabilities under `Added` instead of `Changed`.
- Fixed `revpack status` showing stale target metadata, such as an open state with merged/closed coloring, when a prepared PR/MR bundle still exists after the target changed remotely.
- Fixed `revpack status` next-step guidance when the local checkout is ahead of the latest PR/MR head.
- Fixed `revpack status` for GitLab branch auto-detection so authentication failures are no longer reported as "no open MR found".
- Fixed CLI error handling on Windows to avoid a trailing libuv assertion after provider errors.
- Fixed `revpack publish review` leaving `review.md` populated after publishing, which could republish the same review note during later incremental reviews.
- Fixed `revpack publish all` updating the PR/MR description summary again when `revpack status` already reported the summary as published.
- Fixed debug error logging repeating the user-facing error message before the stack frames.

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
