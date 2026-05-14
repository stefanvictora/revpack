# revpack

AI-ready review bundles for GitHub and GitLab.

`revpack` prepares structured PR/MR context for coding agents and publishes their review outputs back as comments, replies, summaries, and review notes.

## Setup

```bash
npm install
npm run build
```

### Configuration

revpack uses a **profiles** system. Each profile targets one provider instance (GitLab self-hosted, GitHub, etc.) and is matched automatically from the current git remote.

The quickest way to create a profile is the interactive setup wizard:

```bash
revpack config setup
```

This detects your git remote, pre-fills the provider URL and suggested defaults, and writes a named profile to `~/.config/revpack/config.json`.

After setup, set the token environment variable it configured:

```bash
# GitLab
export REVPACK_GITLAB_TOKEN=glpat-xxxxxxxxxxxx

# GitHub
export REVPACK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

Then verify:

```bash
revpack config doctor
```

## Quick Start

```bash
# Optional: add project-specific review guidance and Copilot prompts
revpack setup --prompts

# Prepare a review bundle for the MR/PR of the current branch
revpack prepare
```

Then ask your agent to follow:

```text
.revpack/CONTEXT.md
```

or:

```text
.copilot/prompts/review.prompt.md
```

The agent writes outputs to:

```text
.revpack/outputs/
```

Check pending outputs:

```bash
revpack status
```

Publish outputs:

```bash
revpack publish all
```

Optional: Publish only selected outputs:

```bash
revpack publish findings
revpack publish replies
revpack publish description --from-summary
revpack publish review    # also advances the review checkpoint (for incremental reviews). Must be last.
```

After new commits or new comments:

```bash
revpack prepare
```

To discard local revpack state (`.revpack` folder):

```bash
revpack clean
```

### Working on an MR/PR not checked out locally

```bash
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42
revpack prepare
```

Convenience:

```bash
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42 --prepare
```

Alternative:

```bash
revpack checkout !42 --repo group/project --profile myGitlab
revpack checkout 58 --repo user/project --profile myGithub
```

## Commands

### `prepare [ref]` — Primary workflow

Fetches MR metadata, threads, diffs, and writes the `.revpack/` bundle with a `CONTEXT.md` entry point for agents.

Re-running on the same MR automatically produces a **refresh** (detects code and thread changes since the last prepare). Thread IDs (T-001, T-002, ...) are derived from position in the provider's all-threads list (creation order), so they stay stable as long as existing threads aren't deleted.

**Auto-detection**: When no `ref` is given and no bundle exists, `prepare` looks up the current git branch and finds any open MR sourced from it — no need to pass `!42` manually.

**Branch mismatch safety**: If a bundle exists but the current git branch doesn't match the MR's source branch, `prepare` refuses to proceed and tells you to run `clean` or switch branches.

```bash
revpack prepare                             # auto-detect from branch (or refresh existing bundle)
revpack prepare !42                         # first prepare (fresh)
revpack prepare --fresh                     # discard bundle, start fresh
revpack prepare --discard-outputs           # clear output files before preparing
revpack prepare !42 --json
```

Output shows MR state (opened/merged/closed), prepare mode (fresh/refresh), code/thread change summary, and bundle path.

Creates `.revpack/`:

```
.revpack/
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
revpack checkout !42                        # fetch + switch
revpack checkout !42 --prepare              # fetch + switch + prepare
revpack checkout !42 --setup                # fetch + switch + prepare + setup

revpack checkout !42 --repo group/project --profile myprofile                  # clone when not in a git repo
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42  # direct URL, detects profile automatically
```

By default, `checkout` clones over HTTPS. If your server requires SSH, set `sshClone: true` in the profile (`revpack config setup` will ask, or `revpack config set sshClone true`). SSH agent key loading is handled by Git as normal — if your key needs a passphrase and no agent is running, Git will prompt you in the terminal.

### `status [ref]` — View MR/PR status

Shows MR state, author, branches, dates, labels, URL, prepare summary (mode, code/thread changes), pending outputs, and published actions. Reads from `bundle.json` when available, falls back to provider API fetch.

```bash
revpack status                              # show bundle's MR status
revpack status !42
revpack status !42 --json
```

### `publish` — Publish outputs to the MR/PR

Publishes pending replies, findings, description updates, and review notes. After publishing, automatically refreshes the bundle to pick up the new comments.

```bash
revpack publish all                              # publish everything pending
revpack publish all --no-refresh                 # skip auto-refresh after publishing
revpack publish replies                          # publish all from replies.json
revpack publish replies T-001                    # publish one thread
revpack publish replies T-001 --body "Fixed!"    # inline reply
revpack publish replies T-001 --resolve          # reply and resolve
revpack publish findings                         # publish new findings
revpack publish findings --dry-run               # preview without posting
revpack publish description --from-summary       # update MR description
revpack publish description --from custom.md     # use any file
revpack publish description --from-summary --replace  # replace entire description
revpack publish review                           # publish review.md if non-empty and advance checkpoint
```

### `clean` — Remove local revpack state

Deletes the `.revpack/` directory. The directory is disposable local state — run `prepare` to create a fresh bundle.

```bash
revpack clean
```

### `setup` — Set up a project for revpack

Creates a `REVIEW.md` file in the repository root for project-specific review guidance.

```bash
revpack setup             # creates REVIEW.md
revpack setup --prompts   # also creates .github/prompts/ with Copilot prompts
revpack setup --dry-run   # preview without writing
```

### `config` — Manage configuration

Configuration is stored in `~/.config/revpack/config.json` as named profiles. Each profile holds a provider type, base URL, token env var, and remote match patterns used to auto-select the right profile per repository.

```bash
# Interactive setup — detects git remote, pre-fills suggested values
revpack config setup

# Show resolved config for the current directory
revpack config show
revpack config show --profile myprofile
revpack config show --sources          # show where each value comes from

# Get / set / unset individual keys on a profile
revpack config get <key>
revpack config set <key> <value>
revpack config unset <key>
# --profile <name>  target a specific profile
# --current         resolve profile from current git remote

# Profile management
revpack config profile list
revpack config profile show <name>
revpack config profile create <name>
revpack config profile delete <name>
revpack config profile rename <old> <new>

# Health check
revpack config doctor
revpack config doctor --profile myprofile
```

Configurable keys: `provider`, `url`, `tokenEnv`, `remotePatterns`, `caFile`, `tlsVerify`, `sshClone`.

## Benchmark Export

The `eval:export-code-review-benchmark` script exports locally produced revpack findings into a [Martian code-review-benchmark](https://github.com/MartianLabs/code-review-benchmark) compatible `benchmark_data.json` file.

The script is an **exporter only** — it does not checkout PRs, run `revpack prepare`, invoke a review agent, or publish comments.

### Intended workflow

```text
1. Checkout and prepare benchmark PRs locally with revpack.
2. Run your review agent manually for each prepared workspace.
3. Export all reviewed workspaces into a slim benchmark data file.
4. Run the Martian benchmark scripts separately with --tool <tool>.
```

### Prerequisites

Each workspace must be a prepared revpack workspace with:

```
<workspace>/.revpack/bundle.json
<workspace>/.revpack/outputs/new-findings.json
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
  - `--workspace <repo-root>` — Export a single prepared revpack workspace.
  - `--workspace-root <parent-dir>` — Batch export all immediate child directories that are prepared revpack workspaces.

**Optional:**

- `--tool <name>` — Tool identity written into the benchmark output. Default: `revpack`.

### Examples

Export a single workspace:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace ../revpack-benchmark-workspaces/cal.com-pr-10600
```

Batch export all workspaces under a parent directory:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace-root ../revpack-benchmark-workspaces
```

Export under a custom tool name for variant comparison:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace-root ../revpack-benchmark-workspaces \
  --tool revpack-gpt-5.5
```

### Output

The output file is written to the same directory as `--benchmark-data`, named after the tool slug:

```
benchmark_data.revpack.json
benchmark_data.revpack-gpt-5-5.json
```

The output contains only the benchmark PR entries for which revpack produced a review. Each exported entry preserves all original PR-level metadata and contains exactly one `reviews` entry for the selected tool.

Workspaces are skipped (with a warning in the summary) when:

- The bundle target is not a GitHub pull request.
- The bundle's PR URL does not match any entry in the benchmark data.
- `.revpack/outputs/new-findings.json` is missing.

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
- **Marker-based description updates** — Preserves original MR description; revpack content lives in a marked section
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
