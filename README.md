# revpack

[![build](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml/badge.svg)](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![npm downloads](https://img.shields.io/npm/dm/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![license](https://img.shields.io/npm/l/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![node](https://img.shields.io/node/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)

Prepare GitHub PRs and GitLab MRs for AI code review with structured diffs, unresolved threads, review instructions, safe output files, and publishable comments.

`revpack` does **not** review code itself. It turns a PR/MR into a local review workspace for your coding agent, then lets you inspect and explicitly publish the agent's output.

Use it when you want an agent to review real PRs/MRs without losing unresolved-thread context, guessing line-comment positions, or posting feedback before you inspect it.

```bash
npm install -g @stefanvictora/revpack

revpack config setup
revpack prepare

# Then ask your agent to follow .revpack/CONTEXT.md
```

## Why revpack?

PR/MR review context is awkward for coding agents:

- Provider APIs split diffs, descriptions, review threads, metadata, and valid comment anchors across different endpoints.
- Agents need stable instructions, bounded write locations, and predictable output formats.
- Follow-up reviews should focus on what changed since the last recorded review state.
- Publishing should be explicit, inspectable, and separate from the agent run.

`revpack` packages that context into a local `.revpack/` bundle that the agent can read from and write to without directly touching GitHub or GitLab.

## 60-second workflow

```bash
# 1. Create the review bundle
revpack prepare

# 2. Ask your agent:
# "Review this PR/MR by following .revpack/CONTEXT.md.
#  Write only to .revpack/outputs/.
#  Do not publish anything yourself."

# 3. Inspect pending output
revpack status

# 4. Publish when ready
revpack publish all
```

After new commits or new comments, run `revpack prepare` again to refresh the bundle. Refreshes compare the current PR/MR state with the last recorded review state and generate `incremental.patch` when there are new code changes.

The quoted instruction is a condensed version of the bundled [review prompt](templates/prompts/review.prompt.md). Run `revpack setup --prompts` to install it for Copilot.

Want to see the result? See [examples/basic-review/](examples/basic-review/) for a tiny generated bundle with representative output files.

## What revpack creates

A typical bundle contains the files your agent interacts with most:

```text
.revpack/
  CONTEXT.md              # start here
  AGENT_CONTRACT.md       # non-negotiable agent rules
  INSTRUCTIONS.md         # instruction index for the current task
  description.md          # PR/MR description
  threads/                # unresolved review threads
  diffs/
    latest.patch          # full diff
    incremental.patch     # changed since the last recorded review state
    line-map.ndjson       # valid positional anchors
  outputs/
    new-findings.json     # new line comments
    replies.json          # replies to existing threads
    summary.md            # description summary
    review.md             # optional review-level note
```

`AGENT_CONTRACT.md` defines the non-negotiable rules for the agent, such as where it may write output and how findings must be structured.

`prepare` also writes `bundle.json`, per-file patches, changed-file metadata, output schemas, and task-specific instruction files. The generated context tells the agent where to start and which instructions apply to the current review.

## Core capabilities

- Finds the relevant GitHub PR or GitLab MR from your current branch, a direct URL, or a reference like `#42` or `!42`.
- Prepares a local `.revpack/` bundle with diffs, unresolved threads, metadata, instructions, schemas, and output files.
- Works before a PR/MR exists by reviewing local branch ranges.
- Gives coding agents one clear entry point: `.revpack/CONTEXT.md`.
- Supports incremental refreshes after new commits or review comments.
- Lets you inspect outputs before publishing findings, replies, summaries, or review notes.
- Supports named profiles for multiple GitHub and GitLab instances.

## What revpack is not

- Not an AI reviewer by itself.
- Not a hosted review bot.
- Not tied to one specific coding agent.
- Not a replacement for GitHub/GitLab permissions or branch protection.

Use it with AI coding agents and editors such as GitHub Copilot in VS Code, Claude Code, Codex, Cursor, or any tool that can read and write local files.

## Install

```bash
npm install -g @stefanvictora/revpack
```

## First-time setup

Create a provider profile from inside an existing git repository:

```bash
revpack config setup
```

Running setup in a repository lets `revpack` inspect the git remote and suggest the matching provider settings automatically. You can run it elsewhere, but those suggestions are only available when `revpack` has a repository to reference.

The setup wizard writes a named profile to:

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

Use the least privileged token that can read PR/MR metadata and publish review comments for your workflow.

## Local review before a PR/MR exists

You do not need an open PR or MR to use `revpack`. Prepare the same agent-ready bundle against a local branch range:

```bash
revpack prepare --local
revpack prepare --local main
revpack prepare --local main...HEAD
```

Local mode reviews committed branch changes against an inferred or explicit base branch. Uncommitted working-tree changes are not included.

Discard the local bundle when you no longer need it:

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

When publishing outputs individually, publish `review` last because it records the review state used for incremental refreshes.

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

## More docs

- [Command reference](docs/commands.md)
- [Architecture](docs/architecture.md)

## Design principles

- **Prepare, not review** — revpack prepares context; your agent performs the review.
- **Agent-ready bundles** — context is packaged for LLM consumption, not dumped directly from provider APIs.
- **Threads, not comments** — the core model is thread-oriented for cross-provider portability.
- **Structured outputs** — findings, replies, summaries, and review notes have explicit output files.
- **Read-first, write-guarded** — revpack does not auto-push or auto-post; publishing requires explicit commands.
- **Incremental by default** — refreshes compare new code and comments against the last recorded review state.
- **Provider-neutral core** — GitHub and GitLab details are handled by provider adapters.

## Development

See [docs/architecture.md](docs/architecture.md) for the internal structure and implementation notes.

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

## Status

`revpack` is early but usable for local AI-assisted PR/MR reviews. Current focus:

- Reliable GitHub/GitLab review bundles.
- Safe publishing of findings, replies, summaries, and review notes.
- Local review workflows before a PR/MR exists.
- Future work: patch assistance, durable learnings, CI integration, and MCP support.
