# revkit

CLI toolkit for agent-assisted code reviews — prepare MR/PR context, manage review threads, and publish structured feedback.

## Setup

```bash
npm install
npm run build
```

### Configuration

revkit uses a **profiles** system. Each profile targets one provider instance (GitLab self-hosted, GitHub, etc.) and is matched automatically from the current git remote.

The quickest way to create a profile is the interactive setup wizard:

```bash
revkit config setup
```

This detects your git remote, pre-fills the provider URL and suggested defaults, and writes a named profile to `~/.config/revkit/config.json`.

After setup, set the token environment variable it configured:

```bash
# GitLab
export REVKIT_GITLAB_TOKEN=glpat-xxxxxxxxxxxx

# GitHub
export REVKIT_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

Then verify:

```bash
revkit config doctor
```

## Quick Start

```bash
# Optional: add project-specific review guidance and Copilot prompts
revkit setup --prompts

# Prepare a review bundle for the MR/PR of the current branch
revkit prepare
```

Then ask your agent to follow:

```text
.revkit/CONTEXT.md
```

or:

```text
.copilot/prompts/review.prompt.md
```

The agent writes outputs to:

```text
.revkit/outputs/
```

Check pending outputs:

```bash
revkit status
```

Publish outputs:

```bash
revkit publish all
```

Optional: Publish only selected outputs:

```bash
revkit publish findings
revkit publish replies
revkit publish description --from-summary
revkit publish review    # also advances the review checkpoint (for incremental reviews). Must be last.
```

After new commits or new comments:

```bash
revkit prepare
```

To discard local revkit state (`.revkit` folder):

```bash
revkit clean
```

### Working on an MR/PR not checked out locally

```bash
revkit checkout https://gitlab.example.com/group/project/-/merge_requests/42
revkit prepare
```

Convenience:

```bash
revkit checkout https://gitlab.example.com/group/project/-/merge_requests/42 --prepare
```

Alternative:

```bash
revkit checkout !42 --repo group/project --profile myGitlab
revkit checkout 58 --repo user/project --profile myGithub
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
    latest.patch          ← full MR diff
    incremental.patch     ← changes since last review checkpoint (auto on refresh)
    line-map.ndjson       ← valid positional anchors
    files.json            ← list of changed files with git metadata
    /patches/by-file/     ← file-level patches for easier navigation
  outputs/
    replies.json          ← agent drafts (T-NNN references)
    new-findings.json     ← agent-created issues for proactive review
    summary.md            ← changelog for MR description
    review.md             ← review note synced to MR comment (checkpoint)
```

### `checkout <ref>` — Switch to MR branch

In a git repo: fetches the MR source branch from origin and switches to it. Requires a clean working tree.

Outside a git repo: performs a shallow clone into a new directory (named after the project, like `git clone`).

Does **not** prepare by default. Use `--prepare` to combine checkout and prepare in one command.

```bash
revkit checkout !42                        # fetch + switch
revkit checkout !42 --prepare              # fetch + switch + prepare
revkit checkout !42 --setup                # fetch + switch + prepare + setup

revkit checkout !42 --repo group/project --profile myprofile                  # clone when not in a git repo
revkit checkout https://gitlab.example.com/group/project/-/merge_requests/42  # direct URL, detects profile automatically
```

By default, `checkout` clones over HTTPS. If your server requires SSH, set `sshClone: true` in the profile (`revkit config setup` will ask, or `revkit config set sshClone true`). SSH agent key loading is handled by Git as normal — if your key needs a passphrase and no agent is running, Git will prompt you in the terminal.

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
revkit publish review                           # publish review.md if non-empty and advance checkpoint
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

Configuration is stored in `~/.config/revkit/config.json` as named profiles. Each profile holds a provider type, base URL, token env var, and remote match patterns used to auto-select the right profile per repository.

```bash
# Interactive setup — detects git remote, pre-fills suggested values
revkit config setup

# Show resolved config for the current directory
revkit config show
revkit config show --profile myprofile
revkit config show --sources          # show where each value comes from

# Get / set / unset individual keys on a profile
revkit config get <key>
revkit config set <key> <value>
revkit config unset <key>
# --profile <name>  target a specific profile
# --current         resolve profile from current git remote

# Profile management
revkit config profile list
revkit config profile show <name>
revkit config profile create <name>
revkit config profile delete <name>
revkit config profile rename <old> <new>

# Health check
revkit config doctor
revkit config doctor --profile myprofile
```

Configurable keys: `provider`, `url`, `tokenEnv`, `remotePatterns`, `caFile`, `tlsVerify`, `sshClone`.

## Benchmark Export

The `eval:export-code-review-benchmark` script exports locally produced revkit findings into a [Martian code-review-benchmark](https://github.com/MartianLabs/code-review-benchmark) compatible `benchmark_data.json` file.

The script is an **exporter only** — it does not checkout PRs, run `revkit prepare`, invoke a review agent, or publish comments.

### Intended workflow

```text
1. Checkout and prepare benchmark PRs locally with revkit.
2. Run your review agent manually for each prepared workspace.
3. Export all reviewed workspaces into a slim benchmark data file.
4. Run the Martian benchmark scripts separately with --tool <tool>.
```

### Prerequisites

Each workspace must be a prepared revkit workspace with:

```
<workspace>/.revkit/bundle.json
<workspace>/.revkit/outputs/new-findings.json
```

### Usage

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data <path> \
  (--workspace <repo-root> | --workspace-root <parent-dir>) \
  [--tool <name>]
```

**Required:**

- `--benchmark-data <path>` — Path to the Martian benchmark data JSON file.
- Exactly one of:
  - `--workspace <repo-root>` — Export a single prepared revkit workspace.
  - `--workspace-root <parent-dir>` — Batch export all immediate child directories that are prepared revkit workspaces.

**Optional:**

- `--tool <name>` — Tool identity written into the benchmark output. Default: `revkit`.

### Examples

Export a single workspace:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace ../revkit-benchmark-workspaces/cal.com-pr-10600
```

Batch export all workspaces under a parent directory:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace-root ../revkit-benchmark-workspaces
```

Export under a custom tool name for variant comparison:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace-root ../revkit-benchmark-workspaces \
  --tool revkit-gpt-5.5
```

### Output

The output file is written to the same directory as `--benchmark-data`, named after the tool slug:

```
benchmark_data.revkit.json
benchmark_data.revkit-gpt-5-5.json
```

The output contains only the benchmark PR entries for which revkit produced a review. Each exported entry preserves all original PR-level metadata and contains exactly one `reviews` entry for the selected tool.

Workspaces are skipped (with a warning in the summary) when:

- The bundle target is not a GitHub pull request.
- The bundle's PR URL does not match any entry in the benchmark data.
- `.revkit/outputs/new-findings.json` is missing.

The script fails without writing output when arguments are invalid, benchmark data is malformed, zero reviews would be exported, or any matched workspace has corrupt findings.

## Architecture

Five layers:

1. **Core domain** (`src/core/`) — Provider-neutral types, schemas, errors
2. **Provider adapters** (`src/providers/`) — GitLab and GitHub
3. **Workspace** (`src/workspace/`) — Git operations, bundle creation
4. **Orchestration** (`src/orchestration/`) — Workflow coordination
5. **CLI** (`src/cli/`) — Commander-based commands with `--json` support

### Key design decisions

- **Threads, not comments** — Core model is thread-oriented for cross-provider portability
- **Position-based thread IDs** — T-NNN IDs derived from position in the provider's all-threads list (creation order), no separate mapping file needed
- **Canonical finding schema** — Structured JSON output with severity, status, disposition
- **Agent-ready bundles** — Context packaged for LLM consumption, not raw API dumps
- **Prepare, not review** — `prepare` generates/refreshes the bundle; the agent performs the review; `publish` writes results back
- **Read-first, write-guarded** — No auto-push/auto-post; write operations require explicit commands
- **bundle.json as canonical state** — Single source of truth for bundle metadata, thread mappings, and published actions
- **Marker-based description updates** — Preserves original MR description; revkit content lives in a marked section
- **No file copies in bundle** — Instruction files (REVIEW.md) and source code are read directly from the repo, not copied into the bundle

## Tests, linting, formatting

```bash
npm test
npm lint:fix
npm format
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
- **Phase 5** 🔜 MCP server & automation — MCP server, CI integration
