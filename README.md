# revkit

CLI toolkit for agent-assisted code reviews — prepare MR/PR context, manage review threads, and publish structured feedback.

## Setup

```bash
npm install
npm run build
```

### Configuration

Set environment variables or use `revkit config set`:

```bash
# Required for GitLab
export REVKIT_PROVIDER=gitlab
export REVKIT_GITLAB_URL=https://gitlab.example.com
export REVKIT_GITLAB_TOKEN=glpat-xxxxxxxxxxxx
# or use GITLAB_TOKEN as fallback

# Optional
export REVKIT_REPO=group/project
```

Or configure via file (`~/.config/revkit/config.json`):

```bash
npx revkit config set gitlabUrl https://gitlab.example.com
npx revkit config set gitlabToken glpat-xxxxxxxxxxxx
```

## Quick Start

```bash
# Optional: add project-specific review guidance and Copilot prompts
revkit setup --prompts

# Prepare a review bundle for the MR/PR of the current branch
revkit prepare

# Or prepare a specific MR/PR
revkit prepare !42
```

Then ask your agent to follow:

```text
.revkit/CONTEXT.md
```

The agent writes outputs to:

```text
.revkit/outputs/
```

Check pending outputs:

```bash
revkit status
```

Publish selected outputs:

```bash
revkit publish findings
revkit publish replies
revkit publish notes
revkit publish description --from-summary
```

After new commits or new comments:

```bash
revkit prepare
```

To discard local revkit state:

```bash
revkit clean
```

### Working on an MR/PR not checked out locally

```bash
revkit checkout !42 --repo group/project
revkit prepare
```

Convenience:

```bash
revkit checkout !42 --repo group/project --prepare
```

You can also paste a full GitLab URL instead of `!42`:
```bash
revkit prepare https://gitlab.example.com/group/project/-/merge_requests/42
```

## Commands

### `prepare [ref]` — Primary workflow

Fetches MR metadata, threads, diffs, and writes the `.revkit/` bundle with a `CONTEXT.md` entry point for agents.

Re-running on the same MR automatically produces a **refresh** (detects code and thread changes since the last prepare). Thread IDs (T-001, T-002, ...) are derived from position in the provider's all-threads list (creation order), so they stay stable as long as existing threads aren't deleted.

**Auto-detection**: When no `ref` is given and no bundle exists, `prepare` looks up the current git branch and finds any open MR sourced from it — no need to pass `!42` manually.

**Branch mismatch safety**: If a bundle exists but the current git branch doesn't match the MR's source branch, `prepare` refuses to proceed and tells you to run `clean` or switch branches.

```bash
revkit prepare                             # auto-detect from branch (or refresh existing bundle)
revkit prepare !42                         # first prepare (fresh)
revkit prepare --fresh                     # discard bundle, start fresh
revkit prepare --discard-outputs           # clear output files before preparing
revkit prepare !42 --json
```

Output shows MR state (opened/merged/closed), prepare mode (fresh/refresh), code/thread change summary, and bundle path.

Creates `.revkit/`:
```
.revkit/
  CONTEXT.md              ← agent entry point (start here)
  INSTRUCTIONS.md         ← stable review workflow and output format rules
  bundle.json             ← machine-readable bundle metadata and state
  description.md          ← raw MR/PR description
  threads/
    T-001.md, T-001.json  ← one per unresolved thread (stable IDs)
  diffs/
    latest.patch           ← full MR diff
    incremental.patch      ← changes since last prepare (auto on refresh)
    line-map.json          ← valid positional anchors
  outputs/
    replies.json          ← agent drafts (T-NNN references)
    new-findings.json     ← agent-created issues for proactive review
    summary.md            ← changelog for MR description
    review-notes.md       ← review notes synced to MR comment
```

### `checkout <ref>` — Switch to MR branch

In a git repo: fetches the MR source branch from origin and switches to it. Requires a clean working tree.

Outside a git repo: performs a shallow clone into a new directory (named after the project, like `git clone`).

Does **not** prepare by default. Use `--prepare` to combine checkout and prepare in one command.

```bash
revkit checkout !42                        # fetch + switch
revkit checkout !42 --prepare              # fetch + switch + prepare
revkit checkout !42 --repo group/project   # clone when not in a git repo
```

### `status [ref]` — View MR/PR status

Shows MR state, author, branches, dates, labels, URL, prepare summary (mode, code/thread changes), pending outputs, and published actions. Reads from `bundle.json` when available, falls back to provider API fetch.

```bash
revkit status                              # show bundle's MR status
revkit status !42
revkit status !42 --json
```

### `publish` — Publish outputs to the MR/PR

Publishes pending replies, findings, description updates, and review notes. After publishing, automatically refreshes the bundle to pick up the new comments.

```bash
revkit publish all                              # publish everything pending
revkit publish all --no-refresh                 # skip auto-refresh after publishing
revkit publish replies                          # publish all from replies.json
revkit publish replies T-001                    # publish one thread
revkit publish replies T-001 --body "Fixed!"    # inline reply
revkit publish replies T-001 --resolve          # reply and resolve
revkit publish findings                         # publish new findings
revkit publish findings --dry-run               # preview without posting
revkit publish description --from-summary       # update MR description
revkit publish description --from custom.md     # use any file
revkit publish description --from-summary --replace  # replace entire description
revkit publish notes                            # sync review notes to MR comment
```

### `clean` — Remove local revkit state

Deletes the `.revkit/` directory. The directory is disposable local state — run `prepare` to create a fresh bundle.

```bash
revkit clean
```

### `setup` — Set up a project for revkit

Creates a `REVIEW.md` file in the repository root for project-specific review guidance.

```bash
revkit setup             # creates REVIEW.md
revkit setup --prompts   # also creates .github/prompts/ with Copilot prompts
revkit setup --dry-run   # preview without writing
```

### `config` — Manage configuration

```bash
revkit config show
revkit config set <key> <value>
revkit config init
```

## Architecture

Five layers:

1. **Core domain** (`src/core/`) — Provider-neutral types, schemas, errors
2. **Provider adapters** (`src/providers/`) — GitLab (now), GitHub (future)
3. **Workspace** (`src/workspace/`) — Git operations, bundle creation
4. **Orchestration** (`src/orchestration/`) — Workflow coordination
5. **CLI** (`src/cli/`) — Commander-based commands with `--json` support

### Key design decisions

- **Threads, not comments** — Core model is thread-oriented for cross-provider portability
- **Position-based thread IDs** — T-NNN IDs derived from position in the provider's all-threads list (creation order), no separate mapping file needed
- **Canonical finding schema** — Structured JSON output with severity, confidence, status, disposition
- **Agent-ready bundles** — Context packaged for LLM consumption, not raw API dumps
- **Prepare, not review** — `prepare` generates/refreshes the bundle; the agent performs the review; `publish` writes results back
- **Read-first, write-guarded** — No auto-push/auto-post; write operations require explicit commands
- **bundle.json as canonical state** — Single source of truth for bundle metadata, thread mappings, and published actions
- **Marker-based description updates** — Preserves original MR description; revkit content lives in a marked section
- **No file copies in bundle** — Instruction files (REVIEW.md) and source code are read directly from the repo, not copied into the bundle

## Tests

```bash
npm test
```

## Development

```bash
npm run dev -- prepare !42    # run CLI with tsx (no build needed)
```

## Roadmap

- **Phase 0** ✅ Spike — GitLab auth, MR fetch, discussions, workspace bundle
- **Phase 1** ✅ Read-only assistant — `status`, `prepare`
- **Phase 2** ✅ Assisted replies — `publish`, `update-description`
- **Phase 2.5** ✅ Unified workflow — `prepare` command, CONTEXT.md, incremental support
- **Phase 2.7** ✅ Auto-detect & proactive review — Branch auto-detect, sync status, `publish findings`
- **Phase 2.8** ✅ Workflow redesign — `prepare`/`setup`/`clean`, `bundle.json`, structured context
- **Phase 3** 🔜 Patch assistance — Generate/apply patches, run checks
- **Phase 4** 🔜 Learnings & automation — Durable learnings, CI integration
- **Phase 5** 🔜 Provider expansion & MCP — GitHub adapter, MCP server
