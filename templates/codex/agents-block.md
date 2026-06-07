<!-- revpack:begin -->

## Revpack review bundles

When asked to run a revpack review or inspect a bundle:

1. Locate `.revpack/`: first at the workspace root, then one level deep, such as `subproject/.revpack/`. If multiple bundles exist, ask which one to use.
2. Read `.revpack/CONTEXT.md` first, then follow the referenced contract and instruction files.
3. Only write files under `.revpack/outputs/`.
4. Do not modify source files.
5. Do not run build, test, lint, format, package-manager, migration, Docker, startup, Git-hook, publishing, or repository-audit commands.
6. Review tests by reading diffs and test files, not by executing them.
7. If you accidentally modify files outside `.revpack/outputs/`, stop and report it.

<!-- revpack:end -->
