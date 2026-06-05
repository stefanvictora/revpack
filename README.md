# revpack

[![build](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml/badge.svg)](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![npm downloads](https://img.shields.io/npm/dm/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![license](https://img.shields.io/npm/l/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![node](https://img.shields.io/node/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)

**AI-ready review bundles for GitHub and GitLab — without handing your PR conversation to a bot.**

`revpack` is a review-control layer for teams that want AI-assisted code review while keeping review judgment, PR hygiene, and publishing decisions in human hands.

It is **not another AI reviewer**. Instead, `revpack` turns a GitHub PR, GitLab MR, or local branch range into a structured local workspace that your coding agent can review safely. The agent writes pending output files; you review them at the level appropriate for the change; then you publish intentionally.

Use `revpack` when you want to:

- give AI agents the full review context, including diffs, unresolved threads, metadata, and valid line-comment anchors
- keep agents out of your GitHub/GitLab permissions and publishing flow
- review follow-up commits incrementally instead of re-reviewing the whole PR/MR every time
- publish only the findings, replies, summaries, or review notes you actually want

> [!IMPORTANT]
> `revpack prepare` and the agent review do not post comments.
> The agent writes pending output files locally.
> You stay in control of the final publish step — from a quick sanity check followed by `revpack publish all` to selective publishing for higher-risk reviews.

## Why revpack exists

AI-assisted review is useful when it improves the human review loop.

It becomes harmful when it floods a PR/MR with comments nobody trusts, misses existing discussion, or posts feedback before a human has checked it.

`revpack` is designed for teams that want the first part without the second.

It separates the review workflow into four explicit steps:

```text
prepare review context → run your agent → inspect pending output → publish intentionally
```

That means your coding agent can help with review work without owning the PR/MR conversation.

## 3-minute first run

Open the repository you want to review, then install the CLI:

```bash
npm install -g @stefanvictora/revpack
```

Configure your GitHub or GitLab profile from inside that repository:

```bash
revpack config setup
revpack config doctor
```

Running `config setup` inside a git repository lets `revpack` inspect the remote URL and suggest the matching provider and host. You can run setup elsewhere, but starting from the target repository avoids manual configuration in most cases.

Install an agent command or instruction file for your preferred coding agent:

```bash
revpack setup agent claude
revpack setup agent codex
revpack setup agent cursor
revpack setup agent copilot
```

Prepare a review bundle from the current branch:

```bash
revpack prepare
```

Run the installed revpack review entry point in your agent.

For example, Claude and Copilot expose:

```text
/revpack-review
```

For Cursor and Codex, ask the agent to perform a revpack review. The installed project instructions tell it to start from the prepared bundle.

Inspect the pending output:

```bash
revpack status
```

Publish when you are ready:

```bash
revpack publish all
```

## What happens after `prepare`?

`revpack prepare` creates a local `.revpack/` bundle for the current PR/MR or local branch range.

A successful prepare run tells you which target was prepared, where the bundle was written, and what the next step is:

```text
✓ Bundle prepared

  #5: Add support for other agent harness
  State:   open
  Author:  @stefanvictora
  Threads: 2 unresolved
  Files:   13 changed

  Context: .revpack/CONTEXT.md

Next:
  Run your agent command, for example /revpack-review
```

The bundle is now ready for your coding agent. Nothing has been reviewed or published yet.

After the agent finishes, inspect the pending outputs:

```bash
revpack status
```

Example:

```text
─ Output status ─
  Replies:  2 pending
  Findings: 1 pending
  Summary:  pending
  Review:   empty

Next:
  revpack publish all
```

Pending output means the agent wrote local files under `.revpack/outputs/`. You can quickly check and publish everything, or inspect, edit, dry-run, discard, or publish selected outputs when the review needs more control.

Empty output is valid. For example, `Review: empty` means the agent did not produce a useful PR/MR-level review note.

When you publish everything:

```bash
revpack publish all
```

Example:

```text
2 replies published
1 finding(s) published as PR review
Description updated
Review state updated

Bundle refreshed.
```

## The basic workflow

```text
revpack setup agent <agent>  # once per project, recommended
        │
        ▼
revpack prepare              # per review
        │
        ▼
agent review entry point     # e.g. /revpack-review or installed project instructions
        │
        ▼
revpack status               # check pending outputs
        │
        ▼
revpack publish all          # publish when ready
```

A successful agent run creates or updates pending output files such as findings, thread replies, a PR/MR summary, and an optional review note.

## Agent setup

`revpack` is not tied to one coding agent. It works with any agent that can read and write local files.

The easiest path is to install project-local instructions for your preferred agent:

| Agent                     | Setup command                 | How to run the review                  |
| ------------------------- | ----------------------------- | -------------------------------------- |
| Claude Code               | `revpack setup agent claude`  | Run `/revpack-review`                  |
| GitHub Copilot in VS Code | `revpack setup agent copilot` | Run `/revpack-review`                  |
| Codex                     | `revpack setup agent codex`   | Ask Codex to perform a revpack review  |
| Cursor                    | `revpack setup agent cursor`  | Ask Cursor to perform a revpack review |
| Any file-based agent      | none required                 | Use the manual prompt below            |

`setup agent` installs one agent-specific integration at a time. Claude and Copilot expose `/revpack-review`, Cursor installs an agent-requested project rule, and Codex appends or updates a revpack-managed block in `AGENTS.md` without touching other instructions.

Use `--dry-run` to preview the files without writing them:

```bash
revpack setup agent claude --dry-run
```

## Manual agent prompt

You can use `revpack` without installing an agent command.

After `revpack prepare`, ask your agent:

```text
Read `.revpack/CONTEXT.md` first, then follow the referenced revpack contract and instruction files.
```

This is the fallback path. The recommended path is still `revpack setup agent <agent>`, because the installed agent instructions are easier to reuse and harder to mistype.

## Why not just ask Claude or Codex to review the PR?

You can, and for small local changes that may be enough.

`revpack` helps when the review needs real PR/MR context:

- unresolved review threads
- previous review state
- valid line-comment anchors
- provider metadata
- a stable instruction contract
- structured pending outputs
- explicit publishing

Instead of asking an agent to infer all of that from a checkout, `revpack` prepares the review workspace and gives the agent one clear entry point.

## Why not just use an AI review bot?

AI review bots are convenient, but they often blur boundaries:

- they decide what context to read
- they decide what model to use
- they decide what to post
- they may miss unresolved thread state
- they may comment on invalid or stale diff positions
- they can add noise directly to the PR/MR

`revpack` takes a different approach.

It prepares the review context, constrains the agent output, validates positional anchors, and keeps publishing explicit. The human reviewer stays responsible for what enters the PR/MR conversation.

## What revpack creates

A typical review bundle looks like this:

```text
.revpack/
  CONTEXT.md              # agent entry point for this review run
  AGENT_CONTRACT.md       # mandatory rules for the agent
  INSTRUCTIONS.md         # catalog of task-specific review instructions
  description.md          # PR/MR description
  threads/                # unresolved review threads
  diffs/
    latest.patch          # full diff
    incremental.patch     # changed since the last recorded review state
    line-map.ndjson       # valid positional anchors
  outputs/
    new-findings.json     # new line comments
    replies.json          # replies to existing threads
    summary.md            # PR/MR description summary
    review.md             # optional review-level note
```

`CONTEXT.md` is the run-specific entry point. It tells the agent which review mode applies, points it to the mandatory contract, and lists only the instruction files needed for that run.

`AGENT_CONTRACT.md` defines the non-negotiable rules for the agent, such as where it may write output and how findings must be structured. `INSTRUCTIONS.md` is a catalog of the available task-specific files, not another required hop in the normal reading path.

`prepare` also writes `bundle.json`, per-file patches, changed-file metadata, output schemas, and task-specific instruction files. The generated context tells the agent where to start and which instructions apply to the current review.

## What gets published?

The agent writes pending outputs locally. You choose what to publish.

| Output                                 | File                                 | Publish command               |
| -------------------------------------- | ------------------------------------ | ----------------------------- |
| Replies to existing unresolved threads | `.revpack/outputs/replies.json`      | `revpack publish replies`     |
| New positional findings                | `.revpack/outputs/new-findings.json` | `revpack publish findings`    |
| PR/MR description summary              | `.revpack/outputs/summary.md`        | `revpack publish description` |
| Review state / optional review note    | `.revpack/outputs/review.md`         | `revpack publish review`      |
| Everything                             | all of the above                     | `revpack publish all`         |

Useful variants:

```bash
revpack publish findings --dry-run
revpack publish replies T-001
revpack publish replies T-001 --body "Fixed!"
revpack publish replies T-001 --resolve
revpack publish description --from custom.md
revpack publish description --replace
```

> [!IMPORTANT]
> When publishing outputs individually, publish `review` last because it records the review state used for incremental refreshes.
> Publish-triggered refreshes preserve other pending output files. Run `revpack prepare` explicitly when you want stale replies pruned against the latest thread state.

## Core capabilities

- Prepares GitHub PRs, GitLab MRs, and local branch ranges for AI-assisted review.
- Packages diffs, metadata, unresolved threads, instructions, schemas, and valid comment anchors into a local `.revpack/` workspace.
- Gives coding agents one clear entry point: `.revpack/CONTEXT.md`.
- Supports incremental refreshes after new commits or review comments.
- Lets you inspect pending findings, replies, summaries, and review notes before publishing.
- Works with GitHub Copilot in VS Code, Claude Code, Codex, Cursor, or any agent that can read and write local files.
- Supports named profiles for multiple GitHub and GitLab instances.

## What revpack is not

- Not an AI reviewer by itself.
- Not a hosted review bot.
- Not tied to one specific coding agent.
- Not a replacement for GitHub/GitLab permissions, branch protection, or human review judgment.
- Not a CI replacement for build, test, lint, or security scanning.

## First-time provider setup

Create a provider profile from inside the repository you want to review:

```bash
revpack config setup
```

This gives the setup wizard access to the repository remote, so it can suggest the matching provider settings automatically. You can still run setup outside a repository, but then you may need to enter more values manually.

The setup wizard writes the selected profile to:

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

## Project review guidance

Create a `REVIEW.md` file for project-specific review guidance:

```bash
revpack setup
```

Use `REVIEW.md` for repository-specific priorities, conventions, architectural rules, or review focus areas that your agents should consider during review.

For example, a project might use `REVIEW.md` to say:

```md
# Review Guidelines

Focus especially on:

- API compatibility
- authorization and tenant isolation
- migration safety
- meaningful tests for changed behavior

Do not comment on formatting issues handled by CI.
```

## Incremental reviews

After new commits or new comments, run `prepare` again:

```bash
revpack prepare
```

Refreshes compare the current PR/MR state with the last recorded review state.

When there are new code changes, `revpack` generates an incremental diff so the agent can focus on what changed since the previous review state while still having the full bundle available for context.

## Local review before a PR/MR exists

You do not need an open PR or MR to use `revpack`.

Prepare the same agent-ready bundle against a local branch range:

```bash
revpack prepare --local
revpack prepare --local main
revpack prepare --local main...HEAD
```

> [!NOTE]
> Local mode reviews committed branch changes against an inferred or explicit base branch. Uncommitted working-tree changes are not included.

Discard the local bundle when you no longer need it:

```bash
revpack clean
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

## When revpack may be overkill

You may not need `revpack` if:

- you only want a quick local pre-review before opening a PR
- you do not care about unresolved PR/MR threads
- you are happy with an autonomous hosted review bot
- your team does not want to inspect AI output before publishing

`revpack` is most useful when review context, thread continuity, line anchors, and explicit publishing matter.

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
