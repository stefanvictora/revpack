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
# 1. One-time: set up your project for review-assist
cd your-project
review-assist init --prompts

# 2. Point at a MR — fetches everything, classifies threads, writes CONTEXT.md
review-assist review !42 --repo group/project

# Or just run from a feature branch — auto-detects the open MR:
review-assist review

# 3. Use with your agent (Copilot, Claude, etc.):
#    - Open .review-assist/CONTEXT.md and tell your agent to follow it
#    - Or use a Copilot prompt: /review-quick

# 4. After the developer pushes changes, just re-run (auto-incremental):
review-assist review

# 5. Publish results back to GitLab/GitHub:
review-assist publish-reply
review-assist publish-finding
review-assist update-description --from-summary
```

You can also paste a full GitLab URL instead of `!42`:
```bash
review-assist review https://gitlab.example.com/group/project/-/merge_requests/42
```

## Commands

### `review [ref]` — Primary workflow (recommended)

Fetches MR metadata, threads, diffs, classifies findings, generates a summary, and writes a `CONTEXT.md` entry point for agents.

Re-running on the same MR automatically produces an **incremental** review (only changes since last run). Thread IDs (T-001, T-002, ...) are derived from position in the provider's all-threads list (creation order), so they stay stable as long as existing threads aren't deleted.

**Auto-detection**: When no `ref` is given and no session exists, `review` looks up the current git branch and finds any open MR sourced from it — no need to pass `!42` manually.

```bash
review-assist review !42                          # first review (full)
review-assist review                              # re-run: auto-incremental (or auto-detect from branch)
review-assist review --full                       # discard session, start fresh
review-assist review https://gitlab.example.com/group/project/-/merge_requests/42
review-assist review !42 --json
```

Output shows MR state (opened/merged/closed), last updated date, thread counts, **local branch sync status** (up-to-date / behind / ahead of MR head), and warns if the MR is already merged or closed or if the local branch is behind.

Creates `.review-assist/`:
```
.review-assist/
  CONTEXT.md              ← agent entry point (start here)
  session.json            ← tracks MR ref + last reviewed version
  target.json
  threads/
    T-001.md, T-001.json  ← one per unresolved thread (stable IDs)
  diffs/
    latest.patch           ← full MR diff
    incremental.patch      ← changes since last review (auto on re-run)
  outputs/
    summary.md, summary.json, findings.json
    new-findings.json     ← agent-created issues for proactive review
```

### `status [ref]` — View MR/PR status

Shows MR state, author, branches, dates, labels, URL, and description.

```bash
review-assist status !42
review-assist status !42 --repo group/project
review-assist status https://gitlab.example.com/group/project/-/merge_requests/42
review-assist status !42 --json
```

### `publish-reply [thread]` — Post replies

```bash
review-assist publish-reply                            # publish all from replies.json
review-assist publish-reply T-001                      # publish one thread
review-assist publish-reply T-001 --body "Fixed!"      # inline reply
review-assist publish-reply T-001 --resolve            # reply and resolve
review-assist publish-reply --from custom-replies.json # custom file
```

### `publish-finding` — Create new discussion threads

Publishes agent-generated findings as new discussion threads on the MR. Reads from `outputs/new-findings.json` by default.

```bash
review-assist publish-finding                     # publish all findings
review-assist publish-finding --from custom.json  # use a different file
review-assist publish-finding --dry-run           # preview without posting
```

Expected format for `new-findings.json`:
```json
[
  { "filePath": "src/app.ts", "line": 42, "body": "Potential null dereference", "severity": "high", "category": "correctness" }
]
```

### `update-description [ref]` — Update MR/PR description

Uses HTML comment markers (`<!-- review-assist:start -->` / `<!-- review-assist:end -->`) to append or update a section in the description without overwriting the original.

```bash
review-assist update-description --from-summary     # append/update from summary.md
review-assist update-description --from custom.md   # append/update from any file
review-assist update-description --from-summary --replace  # replace entire description
```

### `init` — Set up a project for review-assist

```bash
review-assist init             # creates REVIEW.md + .review-assist/rules.md
review-assist init --prompts   # also creates .github/prompts/ with Copilot prompts
review-assist init --dry-run   # preview without writing
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
4. **Orchestration** (`src/orchestration/`) — Workflow coordination, classification, summaries
5. **CLI** (`src/cli/`) — Commander-based commands with `--json` support

### Key design decisions

- **Threads, not comments** — Core model is thread-oriented for cross-provider portability
- **Position-based thread IDs** — T-NNN IDs derived from position in the provider's all-threads list (creation order), no separate mapping file needed
- **Canonical finding schema** — Structured JSON output with severity, confidence, status, disposition
- **Agent-ready bundles** — Context packaged for LLM consumption, not raw API dumps
- **Read-first, write-guarded** — No auto-push/auto-post; write operations require explicit commands
- **Marker-based description updates** — Preserves original MR description; review-assist content lives in a marked section
- **No file copies in bundle** — Instruction files (REVIEW.md, rules.md) and source code are read directly from the repo, not copied into the bundle

## Tests

```bash
npm test
```

## Development

```bash
npm run dev -- review !42    # run CLI with tsx (no build needed)
```

## Roadmap

- **Phase 0** ✅ Spike — GitLab auth, MR fetch, discussions, workspace bundle
- **Phase 1** ✅ Read-only assistant — `status`, `review`
- **Phase 2** ✅ Assisted replies — `publish-reply`, `update-description`
- **Phase 2.5** ✅ Unified workflow — `review` command, CONTEXT.md, incremental support
- **Phase 2.7** ✅ Auto-detect & proactive review — Branch auto-detect, sync status, `publish-finding`
- **Phase 3** 🔜 Patch assistance — Generate/apply patches, run checks
- **Phase 4** 🔜 Learnings & automation — Durable learnings, CI integration
- **Phase 5** 🔜 Provider expansion & MCP — GitHub adapter, MCP server
