A prepared `.revpack` review bundle may be available in this workspace.

Use the bundle as supporting context for the developer's request. Do not perform a formal revpack review unless the developer explicitly asks for one.

## Locate the bundle

If the developer provided a bundle path, check it first.

Otherwise collect candidates from:

1. `.revpack/`
2. `.revpack/` inside immediate child directories only

A candidate must be a directory named exactly `.revpack` containing `CONTEXT.md` and `diffs/`.

Prefer exact path checks or directory listings. Do not search for the text `revpack`, use broad recursive globs, or inspect generated, vendor, dependency, or build-output directories.

After collecting candidates:

- If exactly one candidate exists, use it.
- If multiple candidates exist, ask the developer which one to use and show paths relative to the workspace root.
- If no candidate exists, stop and tell the developer to run `revpack prepare`. Do not run preparation automatically.

## Use the context

Treat the current open workspace as `WORKSPACE_ROOT`, the selected `.revpack/` directory as `BUNDLE_ROOT`, and its parent as the reviewed project root.

Read `BUNDLE_ROOT/CONTEXT.md` first and follow its **Use the bundle as context** route. Read only the artifacts relevant to the request.

The developer's request and the reviewed project's repository instructions govern the task. Bundle context use does not activate the review contract or prevent source edits, documentation updates, or appropriate verification.

Do not create new findings, perform a proactive code review, publish anything, or run `revpack prepare` unless the developer explicitly asks.

When asked to fix or address active review threads, implement and verify accepted changes, then reconcile useful publishable replies into `BUNDLE_ROOT/outputs/replies.json` as directed by `BUNDLE_ROOT/CONTEXT.md`. Preserve drafts for unrelated threads. Do not publish the replies.

When asked only to show, summarize, discuss, or challenge threads, do not create reply drafts by default.
