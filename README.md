# revpack

[![build](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml/badge.svg)](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![npm downloads](https://img.shields.io/npm/dm/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![license](https://img.shields.io/npm/l/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![node](https://img.shields.io/node/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)

AI-ready review bundles for GitHub and GitLab.

`revpack` prepares structured PR/MR context for coding agents and publishes their review outputs back as comments, replies, summaries, and review notes.

It does **not** perform the review itself. It gives your agent a reliable workspace, then helps you publish the agent's output safely.

## What revpack does

- Finds the relevant GitHub PR or GitLab MR from your current branch, a direct URL, or a reference like `!42`.
- Creates a local `.revpack/` bundle with diffs, thread context, metadata, instructions, and output files.
- Gives coding agents one clear entry point: `.revpack/CONTEXT.md`.
- Supports incremental refreshes after new commits or new review comments.
- Publishes selected agent outputs back to the PR/MR.
- Works with named configuration profiles, so different GitHub and GitLab instances can coexist.

## Install

```bash
npm install -g @stefanvictora/revpack
```

## First-time setup

Create a provider profile:

```bash
revpack config setup
```

The setup wizard detects your git remote, pre-fills provider settings, and writes a named profile to:

```text
~/.config/revpack/config.json
```

Then set the token environment variable configured by the wizard:

```bash
# GitLab example
export REVPACK_GITLAB_TOKEN=glpat-xxxxxxxxxxxx

# GitHub example
export REVPACK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

Verify the profile before using it:

```bash
revpack config doctor
```

## Basic workflow

Prepare the current branch's PR/MR:

```bash
revpack prepare
```

Or prepare a local review before pushing a branch:

```bash
revpack prepare --local
revpack prepare --local main
revpack prepare --local main...HEAD
```

Then ask your coding agent to follow the generated context file:

```text
.revpack/CONTEXT.md
```

The agent writes its output files to:

```text
.revpack/outputs/
```

Check what is pending:

```bash
revpack status
```

Publish everything that is ready:

```bash
revpack publish all
```

After new commits or new comments, refresh the bundle:

```bash
revpack prepare
```

Discard the local revpack bundle when you no longer need it:

```bash
revpack clean
```

## Optional project setup

Create a `REVIEW.md` file for project-specific review guidance:

```bash
revpack setup
```

Also generate Copilot prompt files:

```bash
revpack setup --prompts
```

Use `--dry-run` to preview the files without writing them:

```bash
revpack setup --dry-run
```

## Working with a PR/MR that is not checked out locally

Checkout and prepare a PR/MR from a URL:

```bash
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42 --prepare
```

Or use provider references:

```bash
revpack checkout !42 --repo group/project --profile myGitlab --prepare
revpack checkout 58 --repo user/project --profile myGithub --prepare
```

Inside an existing git repository, `checkout` fetches and switches to the source branch. Outside a git repository, it creates a shallow clone in a new directory.

## Publishing selected outputs

`revpack publish all` is the simplest option, but you can publish individual output types when you want more control:

```bash
revpack publish findings
revpack publish replies
revpack publish description --from-summary
revpack publish review
```

When publishing outputs individually, publish `review` last. It advances the review checkpoint used for incremental reviews.

Useful variants:

```bash
revpack publish all --no-refresh
revpack publish findings --dry-run
revpack publish replies T-001
revpack publish replies T-001 --body "Fixed!"
revpack publish replies T-001 --resolve
revpack publish description --from custom.md
revpack publish description --from-summary --replace
```

## Command reference

### `prepare [ref]`

Creates or refreshes the `.revpack/` bundle for a PR/MR.

```bash
revpack prepare                             # auto-detect from current branch, or refresh existing bundle
revpack prepare !42                         # prepare a specific GitLab MR
revpack prepare --local                     # prepare a local branch review against the inferred base
revpack prepare --local main                # prepare a local branch review against an explicit base
revpack prepare --local main...HEAD         # prepare a local branch review from an explicit range
revpack prepare --fresh                     # discard the existing bundle and start fresh
revpack prepare --discard-outputs           # clear output files before preparing
revpack prepare !42 --json                  # machine-readable output
```

Behavior:

- If no `ref` is given and no bundle exists, `prepare` finds an open PR/MR sourced from the current git branch.
- If a bundle already exists, `prepare` refreshes it and detects code or thread changes since the last prepare.
- If the current git branch no longer matches the bundled PR/MR source branch, `prepare` stops and asks you to switch branches or run `clean`.
- Thread IDs such as `T-001` are derived from the provider's thread creation order. They stay stable unless existing provider threads are deleted.

Local mode:

- `revpack prepare --local` reviews committed branch changes against an inferred base branch (`origin/main`, `main`, `origin/master`, `master`, `origin/develop`, `develop`, `origin/trunk`, or `trunk`).
- Uncommitted working tree changes are ignored and are not included in the agent context.
- Local findings are stored as local review threads under `.revpack/local/` and appear in the normal `.revpack/threads/T-NNN.*` files after refresh.
- `revpack publish findings`, `revpack publish replies`, and `revpack publish review` work against the active local bundle. Publishing review advances the local checkpoint.

### `checkout <ref>`

Switches to a PR/MR source branch, or clones it when run outside a git repository.

```bash
revpack checkout !42
revpack checkout !42 --prepare
revpack checkout !42 --setup
revpack checkout !42 --repo group/project --profile myprofile
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42
```

Notes:

- In an existing repo, `checkout` requires a clean working tree.
- By default, clones use HTTPS.
- To clone with SSH, set `sshClone: true` in the profile. Git handles SSH keys and passphrase prompts as usual.

### `status [ref]`

Shows PR/MR state, branches, labels, dates, pending outputs, prepare summary, and published actions.

```bash
revpack status
revpack status !42
revpack status !42 --json
```

When a bundle exists, `status` reads from `.revpack/bundle.json`. Otherwise, it fetches from the provider API.

### `publish`

Publishes agent outputs back to the PR/MR.

```bash
revpack publish all
revpack publish replies
revpack publish findings
revpack publish description --from-summary
revpack publish review
```

After publishing, revpack refreshes the bundle by default so the new provider comments are reflected locally.

### `clean`

Deletes the local `.revpack/` directory.

```bash
revpack clean
```

The bundle is disposable local state. Run `prepare` again to recreate it.

### `setup`

Creates project-level files that help agents review consistently.

```bash
revpack setup
revpack setup --prompts
revpack setup --dry-run
```

### `config`

Manages named provider profiles.

```bash
# Interactive setup
revpack config setup

# Show resolved configuration
revpack config show
revpack config show --profile myprofile
revpack config show --sources

# Read or change individual keys
revpack config get <key>
revpack config set <key> <value>
revpack config unset <key>

# Profile management
revpack config profile list
revpack config profile show <name>
revpack config profile create <name>
revpack config profile delete <name>
revpack config profile rename <old> <new>

# Health checks
revpack config doctor
revpack config doctor --profile myprofile
```

Use these options when changing profile-specific values:

```bash
--profile <name>   # target a specific profile
--current          # resolve the profile from the current git remote
```

Configurable keys:

```text
provider, url, tokenEnv, remotePatterns, caFile, tlsVerify, sshClone
```

## Generated bundle layout

`prepare` creates the following local workspace:

```text
.revpack/
  CONTEXT.md              # agent entry point
  INSTRUCTIONS.md         # stable review workflow and output rules
  bundle.json             # machine-readable bundle metadata and state
  description.md          # raw PR/MR description
  threads/
    T-001.md
    T-001.json            # one pair per unresolved thread
  diffs/
    latest.patch          # full PR/MR diff
    incremental.patch     # changes since the last review checkpoint, on refresh
    line-map.ndjson       # valid positional anchors
    files.json            # changed-file index
    patches/by-file/      # per-file patches for easier navigation
  outputs/
    replies.json          # agent replies to existing threads
    new-findings.json     # agent-created findings
    summary.md            # summary for PR/MR description updates
    review.md             # review note and checkpoint marker
```

The agent should start with `CONTEXT.md`, use the generated diff artifacts for review context, and write only to `.revpack/outputs/`.

## Design principles

- **Prepare, not review** — revpack prepares context; your agent performs the review.
- **Agent-ready bundles** — context is packaged for LLM consumption, not dumped directly from provider APIs.
- **Threads, not comments** — the core model is thread-oriented for cross-provider portability.
- **Structured outputs** — findings, replies, summaries, and review notes have explicit output files.
- **Read-first, write-guarded** — revpack does not auto-push or auto-post; publishing requires explicit commands.
- **Incremental by default** — refreshes compare new code and comments against the last prepared or reviewed state.
- **Provider-neutral core** — GitHub and GitLab details are handled by provider adapters.

## Architecture

The codebase is organized into five layers:

1. **Core domain** (`src/core/`) — provider-neutral types, schemas, and errors
2. **Provider adapters** (`src/providers/`) — GitLab and GitHub integrations
3. **Workspace** (`src/workspace/`) — git operations and bundle creation
4. **Orchestration** (`src/orchestration/`) — workflow coordination
5. **CLI** (`src/cli/`) — Commander-based commands with `--json` support

Key implementation decisions:

- `bundle.json` is the canonical local state file.
- Description updates use marker sections so original PR/MR text is preserved.
- `REVIEW.md` and source files are read from the repository, not copied into the bundle.
- T-NNN thread IDs are based on provider thread order instead of a separate mapping file.

## Development

Install dependencies:

```bash
npm install
```

Run the CLI locally:

```bash
npm run dev -- prepare !42
```

Run checks:

```bash
npm test
npm lint:fix
npm format
```

## Roadmap

- **Phase 0** ✅ Spike — GitLab auth, MR fetch, discussions, workspace bundle
- **Phase 1** ✅ Read-only assistant — `status`, `prepare`
- **Phase 2** ✅ Assisted replies — `publish`, `update-description`
- **Phase 2.5** ✅ Unified workflow — `prepare` command, `CONTEXT.md`, incremental support
- **Phase 2.7** ✅ Auto-detect and proactive review — branch auto-detect, sync status, `publish findings`
- **Phase 2.8** ✅ Workflow redesign — `prepare`, `setup`, `clean`, `bundle.json`, structured context
- **Phase 3** 🔜 Patch assistance — generate and apply patches, run checks
- **Phase 4** 🔜 Learnings and automation — durable learnings, CI integration
- **Phase 5** 🔜 MCP server and automation — MCP server, CI integration
