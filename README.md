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

## Commands

### `open <ref>` — View MR/PR metadata

```bash
npx review-assist open !42
npx review-assist open !42 --repo group/project
npx review-assist open https://gitlab.example.com/group/project/-/merge_requests/42
npx review-assist open !42 --json
```

### `threads <ref>` — List review threads

```bash
npx review-assist threads !42              # unresolved only
npx review-assist threads !42 --all        # all threads
npx review-assist threads !42 --json
```

### `prepare <ref>` — Create agent-ready workspace bundle

```bash
npx review-assist prepare !42
npx review-assist prepare !42 --thread abc123 def456
npx review-assist prepare !42 --checkout
npx review-assist prepare !42 --json
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
npx review-assist summarize !42
npx review-assist summarize !42 --json
```

### `publish-reply <ref> <threadId>` — Post a reply

```bash
npx review-assist publish-reply !42 abc123 --body "Fixed, thanks!"
npx review-assist publish-reply !42 abc123 --from reply-draft.md
npx review-assist publish-reply !42 abc123 --from reply-draft.md --resolve
```

### `update-description <ref>` — Update MR/PR description

```bash
npx review-assist update-description !42 --from summary.md
npx review-assist update-description !42 --from-summary
```

### `config` — Manage configuration

```bash
npx review-assist config show
npx review-assist config set <key> <value>
npx review-assist config init
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
- **Phase 3** 🔜 Patch assistance — Generate/apply patches, run checks
- **Phase 4** 🔜 Learnings & incremental review — Durable learnings, version tracking
- **Phase 5** 🔜 Provider expansion & MCP — GitHub adapter, MCP server
