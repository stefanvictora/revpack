# revpack

[![build](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml/badge.svg)](https://github.com/stefanvictora/revpack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![npm downloads](https://img.shields.io/npm/dm/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![license](https://img.shields.io/npm/l/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)
[![node](https://img.shields.io/node/v/%40stefanvictora%2Frevpack.svg)](https://www.npmjs.com/package/@stefanvictora/revpack)

**AI-ready review bundles for GitHub and GitLab — with humans in control of what gets posted.**

`revpack` helps teams use coding agents for PR/MR review without giving the agent control of the PR/MR conversation.

It takes a GitHub PR, GitLab MR, or local branch range and prepares a local `.revpack/` workspace for your agent. That workspace combines the code change with review context: unresolved discussions, previous review state, and valid line-comment positions.

Your agent reviews the workspace and writes proposed outputs locally: findings, thread replies, summaries, and review notes. Nothing is posted until you choose to publish it.

Use `revpack` when you want to:

- give an agent the PR/MR conversation, not just a patch
- avoid repeating already-raised review feedback
- draft replies to unresolved review discussions
- focus follow-up reviews on what changed
- inspect AI-generated output before anything is posted

> [!IMPORTANT]
> `revpack prepare` and the agent review do not post comments.
> The agent writes pending output files locally.
> You stay in control of the final publish step — from `revpack publish all` after a quick sanity check to selective publishing for larger or more sensitive reviews.

## Why revpack exists

AI-assisted review is useful when it helps humans review faster and better.

It is much less useful when it floods PRs/MRs with comments reviewers do not trust, ignores existing discussion, guesses invalid comment positions, or posts feedback before a human has checked it.

`revpack` keeps those concerns separate:

```text
prepare review context → run your agent → inspect pending output → publish intentionally
```

The agent can help with the review, but it does not own the PR/MR conversation.

## First run

Install the CLI once:

```bash
npm install -g @stefanvictora/revpack
```

Then open the repository you want to review.

### 1. Connect revpack to GitHub or GitLab

Create your provider profile:

```bash
revpack config setup
```

`config setup` asks which token environment variable to use. Set that variable before verifying the profile:

```bash
export REVPACK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
# or
export REVPACK_GITLAB_TOKEN=glpat-xxxxxxxxxxxx
```

Then verify the profile:

```bash
revpack config doctor
```

When you run `config setup` from a git repository, `revpack` can inspect the remote URL and suggest the matching provider and host. You can run it elsewhere, but starting from the target repository usually avoids manual configuration.

> [!TIP]
> The setup wizard writes the selected profile to: `~/.config/revpack/config.json`

### 2. Optional: Add team review guidance

For a repository your team owns, create a `REVIEW.md` template:

```bash
revpack setup
```

Customize and commit this file when you want every review to use the same project-specific guidance, such as review priorities, architectural rules, naming conventions, or areas that deserve extra attention.

Skip this step for one-off reviews of another team’s repository.

### 3. Add instructions for your agent

Pick the coding agent you want to use:

```bash
# Pick one:
revpack setup agent claude
revpack setup agent codex
revpack setup agent cursor
revpack setup agent copilot
```

This installs the command or project instructions that tell your agent how to review a revpack bundle.

### 4. Prepare the review bundle

```bash
revpack prepare
```

This creates the local `.revpack/` workspace with the PR/MR context your agent will review.

### 5. Run the agent review

In Claude or Copilot, run:

```text
/revpack-review
```

In Cursor or Codex, ask the agent to perform a revpack review.

### 6. Inspect the pending output

```bash
revpack status
```

### 7. Publish when ready

```bash
revpack publish all
```

## From `prepare` to `publish`

`revpack prepare` creates or refreshes the local `.revpack/` bundle for the current PR/MR or local branch range.

A successful run shows what was prepared and where your agent should start:

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

At this point, nothing has been reviewed or posted. `revpack` has only prepared the local context your agent will read.

Run the agent review next. When it finishes, check what it wrote:

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

`pending` means the agent wrote proposed review content under `.revpack/outputs/`. `empty` is also valid; for example, `Review: empty` means the agent did not write a PR/MR-level review note.

You can publish everything after a quick check:

```bash
revpack publish all
```

For higher-risk reviews, you can inspect, edit, dry-run, discard, or publish selected outputs instead.

The boundary is simple: `prepare` creates local context, the agent writes local output, and `publish` is the step that updates GitHub or GitLab.

## Why not just ask Claude or Codex to review the PR?

For small local changes, you can. Sometimes a checkout and a prompt are enough.

`revpack` helps when the agent should work with the PR/MR conversation, not just the patch:

- understand what the PR/MR is trying to change
- see unresolved review discussions
- avoid repeating issues that were already raised
- draft replies to questions from reviewers or the author
- focus on follow-up commits since the last review

Without that context, an agent can still find useful issues. But it is reviewing in isolation: it may repeat existing feedback, miss open questions, or spend time re-reviewing parts of the diff that were already covered.

`revpack` brings the PR/MR context into a local workspace first. The agent writes the proposed review output there, and you decide what gets published.

## Why not just use an AI review bot?

AI review bots are useful when you want review feedback to appear automatically.

That convenience comes with a trade-off: the bot usually controls what context to read, which model or prompt to use, and what to post back to the PR/MR. Depending on the team and repository, that can be exactly what you want — or it can create noise, repeat existing issues, miss unresolved discussions, or post feedback before a human has checked it.

`revpack` is for teams that want AI help inside a more deliberate review loop:

- you choose the agent
- `revpack` prepares the PR/MR context
- the agent proposes findings, replies, summaries, and review notes
- you inspect the proposed output
- you decide what gets published

The result is still AI-assisted review, but the PR/MR conversation stays under human control.

## When revpack fits

`revpack` is most useful when AI review should work with the full PR/MR conversation, not just the latest patch.

Use it when you want the agent to see unresolved discussions, avoid repeating already-raised feedback, focus on follow-up commits, and write proposed findings or replies that you can inspect before publishing.

You may not need `revpack` when a quick local prompt is enough, when existing PR/MR discussions do not matter, or when your team prefers fully automatic bot comments.

`revpack` does not replace CI or human review judgment. It prepares the review context; your agent reviews it; you decide what gets published.

## Agent instructions

`revpack` works with any coding agent that can read and write local files.

For regular use, install project-level instructions for the agent you use:

```bash
# Pick one:
revpack setup agent claude
revpack setup agent codex
revpack setup agent cursor
revpack setup agent copilot
```

Claude and Copilot add a `/revpack-review` command. Cursor and Codex add project instructions so the agent knows how to review a prepared revpack bundle.

> [!TIP]
> In team repositories, commit the generated agent instructions when you want everyone to use the same review entry point.
> For one-off reviews, you can leave them uncommitted or use the manual prompt below.

Preview generated files before writing them:

```bash
revpack setup agent claude --dry-run
```

### Manual prompt

You can use `revpack` without installing agent instructions.

After `revpack prepare`, ask your agent:

```text
Read `.revpack/CONTEXT.md` first, then follow the referenced revpack contract and instruction files.
```

This is useful for one-off reviews or unsupported agents. For repeated use, installed instructions are easier to run consistently.

## What revpack creates

`revpack prepare` creates a local `.revpack/` bundle for the current review.

The bundle has two main areas: context the agent reads, and output the agent writes.

```text
.revpack/
  # Agent input
  CONTEXT.md              # where the agent starts
  description.md          # PR/MR description
  threads/                # unresolved review discussions
  diffs/
    latest.patch          # full diff
    incremental.patch     # follow-up changes since the last review state
    line-map.ndjson       # valid line-comment locations

  # Agent output
  outputs/
    new-findings.json     # new findings
    replies.json          # thread replies
    summary.md            # PR/MR summary
    review.md             # optional review-level note
```

`CONTEXT.md` tells the agent what kind of review this is, which files to read, and which instructions to follow.

The agent writes its results under `.revpack/outputs/`. Those files stay local until you publish them.

## What gets published?

You choose what gets posted to GitHub or GitLab.

| To publish                   | Run                           |
| ---------------------------- | ----------------------------- |
| Replies to existing threads  | `revpack publish replies`     |
| New line comments            | `revpack publish findings`    |
| PR/MR description summary    | `revpack publish description` |
| Review note and review state | `revpack publish review`      |
| All pending output           | `revpack publish all`         |

Common variants:

```bash
revpack publish findings --dry-run
revpack publish replies T-001
```

> [!IMPORTANT]
> When publishing outputs one by one, publish `review` last. It records the review state used for future incremental runs.
>
> Publishing refreshes the bundle by default but preserves other pending outputs.

## Common workflows

### Refresh after follow-up commits

After new commits or review comments, run:

```bash
revpack prepare
```

`revpack` compares the current PR/MR state with the last recorded review state. When code changed, it includes an incremental diff so the agent can focus on the latest updates while still having the full context available.

### Review a local branch before opening a PR/MR

You can prepare the same agent-ready bundle without an open PR or MR:

```bash
revpack prepare --local
revpack prepare --local main
revpack prepare --local main...HEAD
```

Local mode reviews committed branch changes against an inferred or explicit base branch. Uncommitted working-tree changes are not included.

Clean up the local bundle when you no longer need it:

```bash
revpack clean
```

### Review a PR/MR that is not checked out

Use `checkout` when you want `revpack` to fetch the review branch for you:

```bash
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42 --prepare
```

Provider references work too:

```bash
revpack checkout !42 --repo group/project --profile myGitlab --prepare
revpack checkout 58 --repo user/project --profile myGithub --prepare
```

Inside an existing git repository, `checkout` fetches and switches to the source branch. Outside a git repository, it creates a shallow clone in a new directory.

## Reference

- [Command reference](docs/commands.md)
- [Architecture](docs/architecture.md)

## Design principles

- **Prepare, not review** — `revpack` prepares context; your agent performs the review.
- **Local first** — agents read and write local files before anything is published.
- **Explicit publishing** — nothing is posted until you run a publish command.
- **Conversation-aware** — unresolved threads, replies, summaries, and review state are part of the workflow.
- **Agent-neutral** — use Claude Code, Copilot, Codex, Cursor, or any agent that can work with local files.

## Development

```bash
npm install
npm run dev -- prepare !42
npm test
npm lint:fix
npm format
```

See [docs/architecture.md](docs/architecture.md) for the internal structure and implementation notes.

## Status

`revpack` is early but usable for local AI-assisted PR/MR reviews.

Current focus:

- reliable GitHub/GitLab review bundles
- safe publishing of findings, replies, summaries, and review notes
- local review workflows before a PR/MR exists

Future work may include patch assistance, durable learnings, CI integration, and MCP support.
