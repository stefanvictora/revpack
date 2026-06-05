## Find the review bundle

If the user provides a bundle path, check that location first; otherwise discover the bundle automatically.

A valid bundle is a `.revpack/` directory containing:

- `CONTEXT.md`
- `AGENT_CONTRACT.md`
- `diffs/`

Look for valid bundles in:

- `.revpack/`
- one-level-deep child directories, for example `subproject/.revpack/`

Ignore generated, vendor, dependency, and build-output directories.

If exactly one valid bundle exists, use it.

If multiple valid bundles exist, ask the developer which one to use. Show the candidate paths relative to the workspace root.

If no valid bundle exists, stop and report that no revpack bundle was found.

## Use the selected bundle consistently

After selecting the bundle:

- Treat the selected `.revpack/` directory as `BUNDLE_ROOT`.
- Treat the directory containing `BUNDLE_ROOT` as the reviewed project root.
- Treat `.revpack/...` in all revpack instructions as `BUNDLE_ROOT/...`.
- Write outputs only under `BUNDLE_ROOT/outputs/`.
- Resolve changed source-file paths against the reviewed project root.
- In `new-findings.json`, copy `oldPath` and `newPath` exactly from `BUNDLE_ROOT/diffs/line-map.ndjson`; do not prefix them with the child-project path.

You may read files outside the reviewed project when they provide relevant workspace-level context, but do not modify them.

## Read guidance and instructions

Read these files in order:

1. `BUNDLE_ROOT/CONTEXT.md`
2. `BUNDLE_ROOT/AGENT_CONTRACT.md`
3. The instruction files listed in `CONTEXT.md` under **Required Instructions for This Run**
4. `REVIEW.md` at the workspace root, if present
5. `REVIEW.md` at the reviewed project root, if present and different from the workspace-level file

Use workspace-level `REVIEW.md` as shared review policy for all child projects. Use project-level guidance for repository-specific conventions.

If shared and project-level guidance conflict, prefer project-level guidance for local implementation conventions, but do not ignore shared domain, architecture, compatibility, or spec-verification rules.

Use `BUNDLE_ROOT/INSTRUCTIONS.md` only when you need the wider instruction catalog.

## Perform the review

Follow `BUNDLE_ROOT/CONTEXT.md` and the required instruction files for the current run mode.

Perform the requested review. Do not implement fixes during a revpack review.
Do not modify source files.
Do not modify files outside `BUNDLE_ROOT/outputs/`.
Do not publish anything unless the developer explicitly asks you to publish.

At the end, present a concise summary of what you found and which files under `BUNDLE_ROOT/outputs/` you wrote or updated.
