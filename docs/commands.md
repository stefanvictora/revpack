# Command reference

## `prepare [ref]`

Creates or refreshes the `.revpack/` bundle for a PR/MR.

```bash
revpack prepare                             # auto-detect from current branch, or refresh existing bundle
revpack prepare !42                         # prepare a specific GitLab MR
revpack prepare --local                     # prepare a local branch review against the inferred base
revpack prepare --local main                # prepare a local branch review against an explicit base
revpack prepare --local main...HEAD         # prepare a local branch review from an explicit range
revpack prepare --fresh                     # discard the existing bundle and start fresh
revpack prepare --discard-outputs           # clear output files before preparing
revpack prepare !42 --json                  # machine-readable output
```

Behavior:

- If no `ref` is given and no bundle exists, `prepare` finds an open PR/MR sourced from the current git branch.
- If a bundle already exists, `prepare` refreshes it and detects code or thread changes since the last recorded review state.
- If the current git branch no longer matches the bundled PR/MR source branch, `prepare` stops and asks you to switch branches or run `clean`.
- Thread IDs such as `T-001` are derived from the provider's thread creation order. They stay stable unless existing provider threads are deleted.

Local mode:

- `revpack prepare --local` reviews committed branch changes against an inferred base branch (`origin/main`, `main`, `origin/master`, `master`, `origin/develop`, `develop`, `origin/trunk`, or `trunk`).
- Uncommitted working tree changes are ignored and are not included in the agent context.
- Local findings are stored as local review threads under `.revpack/local/` and appear in the normal `.revpack/threads/T-NNN.*` files after refresh.
- `revpack publish findings`, `revpack publish replies`, and `revpack publish review` work against the active local bundle. Publishing review records the local review state.

## `checkout <ref>`

Switches to a PR/MR source branch, or clones it when run outside a git repository.

```bash
revpack checkout !42
revpack checkout !42 --prepare
revpack checkout !42 --setup
revpack checkout !42 --repo group/project --profile myprofile
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42
```

Notes:

- In an existing repo, `checkout` requires a clean working tree.
- By default, clones use HTTPS.
- To clone with SSH, set `sshClone: true` in the profile. Git handles SSH keys and passphrase prompts as usual.

## `status [ref]`

Shows PR/MR state, branches, labels, dates, pending outputs, prepare summary, and published actions.

```bash
revpack status
revpack status !42
revpack status !42 --json
```

When a bundle exists, `status` reads from `.revpack/bundle.json`. Otherwise, it fetches from the provider API.

## `publish`

Publishes agent outputs back to the PR/MR.

```bash
revpack publish all
revpack publish replies
revpack publish findings
revpack publish description --from-summary
revpack publish review
```

After publishing, revpack refreshes the bundle by default so the new provider comments are reflected locally.

## `clean`

Deletes the local `.revpack/` directory.

```bash
revpack clean
```

The bundle is disposable local state. Run `prepare` again to recreate it.

## `setup`

Creates project-level files that help agents review consistently.

```bash
revpack setup
revpack setup --prompts
revpack setup --dry-run
```

## `config`

Manages named provider profiles.

```bash
# Interactive setup
revpack config setup

# Show resolved configuration
revpack config show
revpack config show --profile myprofile
revpack config show --sources

# Read or change individual keys
revpack config get <key>
revpack config set <key> <value>
revpack config unset <key>

# Profile management
revpack config profile list
revpack config profile show <name>
revpack config profile create <name>
revpack config profile delete <name>
revpack config profile rename <old> <new>

# Health checks
revpack config doctor
revpack config doctor --profile myprofile
```

Use these options when changing profile-specific values:

```bash
--profile <name>   # target a specific profile
--current          # resolve the profile from the current git remote
```

Configurable keys:

```text
provider, url, tokenEnv, remotePatterns, caFile, tlsVerify, sshClone
```
