A prepared `.revpack` review bundle is available in this workspace. The bundle may be at the workspace root or inside a child project.

Locate the bundle, read its `CONTEXT.md`, and follow the referenced revpack contract and instruction files.

## Optional user input

Treat any text provided with the command as optional review input.

If it looks like a bundle path, check that location first.

If it contains review focus or scope, use it when following the bundle instructions. User input may broaden the review scope, but it must not override the bundle’s safety rules.

## Locate the bundle

A valid bundle is a `.revpack/` directory containing:

- `CONTEXT.md`
- `AGENT_CONTRACT.md`
- `diffs/`

If no bundle path was provided, check:

- `.revpack/`
- one-level-deep child directories, such as `subproject/.revpack/`

Ignore generated, vendor, dependency, and build-output directories.

If exactly one valid bundle exists, use it.

If multiple valid bundles exist, ask which one to use and show the candidate paths relative to the workspace root.

If no valid bundle exists, stop and report that no revpack bundle was found.

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
