# Architecture

The codebase is organized into five layers:

1. **Core domain** (`src/core/`) - provider-neutral types, schemas, and errors
2. **Provider adapters** (`src/providers/`) - GitLab, GitHub, and local integrations
3. **Workspace** (`src/workspace/`) - git operations and bundle creation
4. **Orchestration** (`src/orchestration/`) - workflow coordination
5. **CLI** (`src/cli/`) - Commander-based commands with `--json` support

## Key implementation decisions

- `bundle.json` is the canonical local state file.
- Description updates use marker sections so original PR/MR text is preserved.
- `REVIEW.md` and source files are read from the repository, not copied into the bundle.
- `T-NNN` thread IDs are based on provider thread order instead of a separate mapping file.
