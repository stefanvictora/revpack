<!-- revpack:begin -->

## Revpack review bundles

When asked to run a revpack review or inspect a revpack bundle, locate the `.revpack/` directory. Look first for `.revpack/` at the workspace root, then for one-level-deep child project bundles such as `subproject/.revpack/`; if multiple bundles exist, ask which one to use.

Read `.revpack/CONTEXT.md` first, then follow the referenced revpack contract and instruction files.

Do not modify source files for a revpack review. Only write files under `.revpack/outputs/` unless the user explicitly asks for something else.

<!-- revpack:end -->
