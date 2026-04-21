# review-assist

CLI assistant for code review workflows — fetch MR/PR threads, prepare agent-ready context, assist resolution, generate summaries.

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

# 3. Use with your agent (Copilot, Claude, etc.):
#    - Open .review-assist/CONTEXT.md and tell your agent to follow it
#    - Or use a Copilot prompt: /review-quick

# 4. After the developer pushes changes, just re-run (auto-incremental):
review-assist review

# 5. Publish results back to GitLab/GitHub:
review-assist publish-reply !42 <threadId> --from .review-assist/outputs/replies.json
review-assist update-description !42 --from .review-assist/outputs/summary.md
```

You can also paste a full GitLab URL instead of `!42`:
```bash
review-assist review https://gitlab.example.com/group/project/-/merge_requests/42
```

## Commands

### `review [ref]` — Primary workflow (recommended)

Fetches MR metadata, threads, diffs, classifies findings, generates a summary, and writes a `CONTEXT.md` entry point for agents.

Re-running on the same MR automatically produces an **incremental** review (only changes since last run). Thread IDs (T-001, T-002, ...) are stable across runs — they never shift when threads get resolved or new ones appear.

```bash
review-assist review !42                          # first review (full)
review-assist review                              # re-run: auto-incremental from session
review-assist review --full                       # discard session, start fresh
review-assist review !42 --checkout               # also checkout the source branch
review-assist review https://gitlab.example.com/group/project/-/merge_requests/42
review-assist review !42 --json
```

Creates `.review-assist/`:
```
.review-assist/
  CONTEXT.md              ← agent entry point (start here)
  session.json            ← tracks MR ref + last reviewed version
  thread-map.json         ← stable T-NNN ↔ thread SHA mapping
  target.json
  threads/
    T-001.md, T-001.json  ← one per unresolved thread (stable IDs)
  diffs/
    latest.patch           ← full MR diff
    incremental.patch      ← changes since last review (auto on re-run)
  files/
    *_snippet.txt          ← code excerpts around threads
  instructions/
    REVIEW.md, project-review-rules.md
  outputs/
    summary.md, summary.json, findings.json
```

### `open <ref>` — View MR/PR metadata

```bash
review-assist open !42
review-assist open !42 --repo group/project
review-assist open https://gitlab.example.com/group/project/-/merge_requests/42
review-assist open !42 --json
```

### `threads <ref>` — List review threads

```bash
review-assist threads !42              # unresolved only
review-assist threads !42 --all        # all threads
review-assist threads !42 --json
```

### `prepare <ref>` — Create agent-ready workspace bundle (low-level)

```bash
review-assist prepare !42
review-assist prepare !42 --thread abc123 def456
review-assist prepare !42 --checkout
review-assist prepare !42 --json
```

Creates a `.review-assist/` bundle:

```
.review-assist/
  session.json
  target.json
  threads/
    T-001.json
    T-001.md
  diffs/
    latest.patch
  files/
    src_main_..._snippet.txt
  instructions/
    CLAUDE.md
    REVIEW.md
    project-review-rules.md
  outputs/
    summary.md
    summary.json
```

### `summarize <ref>` — Generate walkthrough & summary

```bash
review-assist summarize !42
review-assist summarize !42 --json
```

### `publish-reply <ref> <threadId>` — Post a reply

```bash
review-assist publish-reply !42 abc123 --body "Fixed, thanks!"
review-assist publish-reply !42 abc123 --from reply-draft.md
review-assist publish-reply !42 abc123 --from reply-draft.md --resolve
```

### `update-description <ref>` — Update MR/PR description

```bash
review-assist update-description !42 --from summary.md
review-assist update-description !42 --from-summary
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
- **Canonical finding schema** — Structured JSON output with severity, confidence, status, disposition
- **Agent-ready bundles** — Context packaged for LLM consumption, not raw API dumps
- **Read-first, write-guarded** — No auto-push/auto-post; write operations require explicit commands
- **MCP-compatible naming** — Internal concepts map cleanly to future MCP resources/prompts/tools

## Tests

```bash
npm test
```

## Development

```bash
npm run dev -- open !42    # run CLI with tsx (no build needed)
```

## Roadmap

- **Phase 0** ✅ Spike — GitLab auth, MR fetch, discussions, workspace bundle
- **Phase 1** ✅ Read-only assistant — `open`, `threads`, `prepare`, `summarize`
- **Phase 2** ✅ Assisted replies — `publish-reply`, `update-description`
- **Phase 2.5** ✅ Unified workflow — `review` command, CONTEXT.md, incremental support
- **Phase 3** 🔜 Patch assistance — Generate/apply patches, run checks
- **Phase 4** 🔜 Learnings & automation — Durable learnings, CI integration
- **Phase 5** 🔜 Provider expansion & MCP — GitHub adapter, MCP server
