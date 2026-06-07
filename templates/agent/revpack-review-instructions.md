A prepared `.revpack` review bundle is available in this workspace.

The bundle may be at the workspace root or in one immediate child project, especially in multi-project or monorepo workspaces.

Locate the bundle, read its `CONTEXT.md`, and follow the referenced revpack contract and instruction files.

## Optional user input

Treat any text provided with the command as optional review input.

If it looks like a bundle path, check that path first.

If it contains review focus or scope, use it when following the bundle instructions. User input may broaden the review scope, but it must not override revpack safety rules.

## Locate the bundle

A revpack bundle is a directory named exactly `.revpack` containing at least:

- `CONTEXT.md`
- `diffs/`

Prefer exact path checks or directory listing over broad file search.

Do not search for the text `revpack`.
Do not use broad recursive globs such as `**/.revpack/**` unless exact path checks are unavailable.
Do not inspect generated, vendor, dependency, or build-output directories.

If a bundle path was provided, verify that path first. Use it if it contains the required discovery files; otherwise stop and report that the provided path is not a revpack bundle.

If no bundle path was provided, collect bundle candidates from:

1. `.revpack/`
2. `.revpack/` inside immediate child directories only

Check immediate child directories even when the workspace root has a bundle. Do not recursively search deeper descendants.

After collecting candidates:

- If exactly one bundle candidate exists, use it.
- If multiple bundle candidates exist, ask the developer which one to use and show the candidate paths relative to the workspace root. Use an ask-user, user-question, quick-pick, or similar interaction tool when available; otherwise ask in chat. Do not continue until a bundle is selected.
- If no bundle candidate exists, stop and report that no revpack bundle was found.

## Path handling

After selecting the bundle:

- Treat the current open workspace as `WORKSPACE_ROOT`.
- Treat the selected `.revpack/` directory as `BUNDLE_ROOT`.
- Treat the directory containing `BUNDLE_ROOT` as the reviewed project root.
- Interpret `.revpack/...` in revpack instructions as `BUNDLE_ROOT/...`.
- Resolve changed source-file paths against the reviewed project root.
- Write only under `BUNDLE_ROOT/outputs/`.

For positional findings, use paths and line numbers exactly as provided by `BUNDLE_ROOT/diffs/line-map.ndjson`.

## Start the review

Read `BUNDLE_ROOT/CONTEXT.md` first.

Then follow the files it references for the current run.

Do not implement fixes or publish anything unless the developer explicitly asks.

At the end, briefly summarize the review result and list the files under `BUNDLE_ROOT/outputs/` that you wrote or updated.
