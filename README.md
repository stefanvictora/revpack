# review-assist

CLI assistant for code review workflows — fetch MR/PR threads, prepare agent-ready context, assist resolution, generate summaries, and enable agent-driven proactive review.

## Setup

```bash
npm install
npm run build
```

### Configuration

Set environment variables or use `review-assist config set`:

```bash
# Required for GitLab
export REVIEW_ASSIST_PROVIDER=gitlab
export REVIEW_ASSIST_GITLAB_URL=https://gitlab.example.com
export REVIEW_ASSIST_GITLAB_TOKEN=glpat-xxxxxxxxxxxx
# or use GITLAB_TOKEN as fallback

# Optional
export REVIEW_ASSIST_REPO=group/project
```

Or configure via file (`~/.config/review-assist/config.json`):

```bash
npx review-assist config set gitlabUrl https://gitlab.example.com
npx review-assist config set gitlabToken glpat-xxxxxxxxxxxx
```

## Quick Start

```bash
# Optional: add project-specific review guidance and Copilot prompts
review-assist setup --prompts

# Prepare a review bundle for the MR/PR of the current branch
review-assist prepare

# Or prepare a specific MR/PR
review-assist prepare !42
```

Then ask your agent to follow:

```text
.review-assist/CONTEXT.md
```

The agent writes outputs to:

```text
.review-assist/outputs/
```

Check pending outputs:

```bash
review-assist status
```

Publish selected outputs:

```bash
review-assist publish findings
review-assist publish replies
review-assist publish notes
review-assist publish description --from-summary
```

After new commits or new comments:

```bash
review-assist prepare
```

To discard local review-assist state:

```bash
review-assist clean
```

### Working on an MR/PR not checked out locally

```bash
review-assist checkout !42 --repo group/project
review-assist prepare
```

Convenience:

```bash
review-assist checkout !42 --repo group/project --prepare
```

You can also paste a full GitLab URL instead of `!42`:
```bash
review-assist prepare https://gitlab.example.com/group/project/-/merge_requests/42
```

## Commands

### `prepare [ref]` — Primary workflow

Fetches MR metadata, threads, diffs, and writes the `.review-assist/` bundle with a `CONTEXT.md` entry point for agents.

Re-running on the same MR automatically produces a **refresh** (detects code and thread changes since the last prepare). Thread IDs (T-001, T-002, ...) are derived from position in the provider's all-threads list (creation order), so they stay stable as long as existing threads aren't deleted.

**Auto-detection**: When no `ref` is given and no bundle exists, `prepare` looks up the current git branch and finds any open MR sourced from it — no need to pass `!42` manually.

**Branch mismatch safety**: If a bundle exists but the current git branch doesn't match the MR's source branch, `prepare` refuses to proceed and tells you to run `clean` or switch branches.

```bash
review-assist prepare                             # auto-detect from branch (or refresh existing bundle)
review-assist prepare !42                         # first prepare (fresh)
review-assist prepare --fresh                     # discard bundle, start fresh
review-assist prepare --discard-outputs           # clear output files before preparing
review-assist prepare !42 --json
```

Output shows MR state (opened/merged/closed), prepare mode (fresh/refresh), code/thread change summary, and bundle path.

Creates `.review-assist/`:
```
.review-assist/
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
review-assist checkout !42                        # fetch + switch
review-assist checkout !42 --prepare              # fetch + switch + prepare
review-assist checkout !42 --repo group/project   # clone when not in a git repo
```

### `status [ref]` — View MR/PR status

Shows MR state, author, branches, dates, labels, URL, prepare summary (mode, code/thread changes), pending outputs, and published actions. Reads from `bundle.json` when available, falls back to provider API fetch.

```bash
review-assist status                              # show bundle's MR status
review-assist status !42
review-assist status !42 --json
```

### `publish` — Publish outputs to the MR/PR

Publishes pending replies, findings, description updates, and review notes. After publishing, automatically refreshes the bundle to pick up the new comments.

```bash
review-assist publish all                              # publish everything pending
review-assist publish all --no-refresh                 # skip auto-refresh after publishing
review-assist publish replies                          # publish all from replies.json
review-assist publish replies T-001                    # publish one thread
review-assist publish replies T-001 --body "Fixed!"    # inline reply
review-assist publish replies T-001 --resolve          # reply and resolve
review-assist publish findings                         # publish new findings
review-assist publish findings --dry-run               # preview without posting
review-assist publish description --from-summary       # update MR description
review-assist publish description --from custom.md     # use any file
review-assist publish description --from-summary --replace  # replace entire description
review-assist publish notes                            # sync review notes to MR comment
```

### `clean` — Remove local review-assist state

Deletes the `.review-assist/` directory. The directory is disposable local state — run `prepare` to create a fresh bundle.

```bash
review-assist clean
```

### `setup` — Set up a project for review-assist

Creates a `REVIEW.md` file in the repository root for project-specific review guidance.

```bash
review-assist setup             # creates REVIEW.md
review-assist setup --prompts   # also creates .github/prompts/ with Copilot prompts
review-assist setup --dry-run   # preview without writing
```

### `config` — Manage configuration

```bash
review-assist config show
review-assist config set <key> <value>
review-assist config init
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
- **Marker-based description updates** — Preserves original MR description; review-assist content lives in a marked section
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
