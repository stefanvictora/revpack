# revpack

[![build](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml/badge.svg)](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![npm downloads](https://img.shields.io/npm/dm/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![license](https://img.shields.io/npm/l/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![node](https://img.shields.io/node/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)

**Local AI review bundles for GitHub, GitLab, Bitbucket Cloud, and local branches — with humans in control of what gets published.**

`revpack` turns a GitHub PR, GitLab MR, Bitbucket Cloud PR, or local branch range into a local review bundle for coding agents. The bundle contains the diff, unresolved review discussions, previous review state, and valid line-comment positions.

Your agent reviews that local bundle and writes proposed outputs: findings, thread replies, summaries, and review notes. Nothing is posted to the provider until you publish it.

```text
prepare review context → run your agent → inspect pending output → publish intentionally
```

Use `revpack` when you want AI-assisted review that is conversation-aware, agent-neutral, and human-controlled.

## Quick start

Install the CLI:

```bash
npm install -g @stefanvictora/revpack
```

Open the repository you want to review, then configure a provider profile:

```bash
revpack connect
export REVPACK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
# or
export REVPACK_GITLAB_TOKEN=glpat-xxxxxxxxxxxx
# or
export REVPACK_BITBUCKET_EMAIL=you@example.com
export REVPACK_BITBUCKET_TOKEN=ATBBTxxxxxxxxxxxx
revpack doctor
```

Add review guidance and instructions for your agent:

```bash
# Pick one:
revpack setup --agent claude
revpack setup --agent codex
revpack setup --agent cursor
revpack setup --agent copilot
```

This creates `REVIEW.md` when missing and writes project-level instruction files, such as an agent command, skill, or prompt. It does not install or run the agent.

Use `--dry-run` to preview generated files before writing them.

Prepare, review, inspect, and publish:

```bash
revpack prepare
# Start the review in your agent:
# Claude, Copilot, or Cursor: /revpack-review
# Codex: $revpack-review
# Or ask any agent to perform a revpack review.
revpack status
revpack publish all
```

## How it works

`revpack prepare` creates or refreshes `.revpack/` for the current PR/MR or local branch range.

The bundle gives the agent the review context it needs:

```text
.revpack/
  CONTEXT.md              # agent entry point
  description.md          # PR/MR description
  threads/                # unresolved review discussions
  diffs/
    latest.patch          # full diff
    incremental.patch     # follow-up changes, when a checkpoint exists
    line-map.ndjson       # valid line-comment locations
  outputs/
    new-findings.json     # new line comments
    replies.json          # replies to existing threads
    summary.md            # PR/MR summary
    review.md             # optional review-level note
```

The bundle is local and disposable. Use `revpack clean` to remove it, then run `revpack prepare` to recreate it. Published checkpoints are stored with the PR/MR, so cleaning the local bundle does not reset incremental review history.

The agent reads the input files and writes only to `.revpack/outputs/`. You can inspect or edit those files before publishing.

## Publishing

You decide what goes back to the provider.

| Output                      | Command                      |
| --------------------------- | ---------------------------- |
| All pending outputs         | `revpack publish all`        |
| New line comments           | `revpack publish findings`   |
| Replies to existing threads | `revpack publish replies`    |
| PR/MR summary               | `revpack publish summary`    |
| Review note                 | `revpack publish review`     |
| Review checkpoint           | `revpack publish checkpoint` |

Useful variants:

```bash
revpack publish findings --dry-run
revpack publish replies T-001
```

> [!IMPORTANT]
> When publishing selected outputs, publish `checkpoint` last. It records the reviewed PR/MR state used for future incremental reviews.

## When revpack fits

`revpack` is useful when the agent should review more than a patch.

It helps when you want to:

- include unresolved PR/MR discussions in the agent run
- avoid repeating already-raised feedback
- draft replies to reviewer or author questions
- focus follow-up reviews on what changed since the last checkpoint
- inspect AI-generated output before it reaches the PR/MR
- use your preferred agent instead of a fixed review bot

You may not need `revpack` for quick local changes, reviews where the PR/MR discussion does not matter, or teams that prefer fully automatic bot comments.

`revpack` does not replace CI or human review judgment. It prepares the review context; your agent reviews it; you decide what gets published.

## Common workflows

### Refresh after follow-up commits

```bash
revpack prepare
```

If a checkpoint exists, `revpack` includes the latest code and thread changes since that checkpoint so the agent can focus its follow-up review.

### Review a local branch before opening a PR/MR

```bash
revpack prepare --local
revpack prepare --local main
revpack prepare --local main...HEAD
```

Local mode reviews committed branch changes against an inferred or explicit base branch. Uncommitted working-tree changes are not included.

### Review a PR/MR that is not checked out

```bash
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42
revpack checkout !42 --repo group/project --profile myGitlab
revpack checkout 58 --repo user/project --profile myGithub
```

Inside a repository, `checkout` fetches and switches to the review branch. Outside a repository, it creates a shallow clone. In both cases, it prepares the bundle after checkout.

### Use an unsupported agent

After `revpack prepare`, ask the agent:

```text
Read `.revpack/CONTEXT.md` first, then follow the referenced revpack contract and instruction files.
```

For repeated use, add project-level instructions for your agent with `revpack setup agent <target>`.

## Reference

- [Command reference](docs/commands.md)
- [Architecture](docs/architecture.md)

## Development

```bash
npm install
npm run dev -- prepare !42
npm test
npm lint:fix
npm format
```

## Status

`revpack` is early but usable for local AI-assisted PR/MR reviews. Expect CLI details and bundle internals to evolve while the provider workflows stabilize.
