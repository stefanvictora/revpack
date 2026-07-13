# Command reference

## Primary workflow

```bash
revpack auth setup                 # set up provider authentication
revpack auth doctor                # check provider authentication
revpack setup --agent codex        # create REVIEW.md and install one agent adapter
revpack prepare                    # create or refresh the review bundle
# run your agent
revpack status
revpack publish all
```

For another PR/MR, use `revpack checkout <url-or-id>`. For a local branch review, use `revpack prepare --local [base]`.

## `prepare [ref]`

Creates or refreshes the `.revpack/` bundle for a PR/MR.

```bash
revpack prepare                             # auto-detect from current branch, or refresh existing bundle
revpack prepare !42                         # prepare a specific GitLab MR
revpack prepare 58 --profile myGithub       # prepare a specific GitHub PR
revpack prepare --local                     # prepare a local branch review against the inferred base
revpack prepare --local main                # prepare a local branch review against an explicit base
revpack prepare --local main...HEAD         # prepare a local branch review from an explicit range
revpack prepare --fresh                     # discard the existing bundle and start fresh
revpack prepare --discard-outputs           # clear output files before preparing
revpack prepare !42 --json                  # machine-readable output
```

Behavior:

- If no `ref` is given and no bundle exists, `prepare` finds an open PR/MR sourced from the current git branch.
- Remote target refs can be provider URLs or compact refs. GitLab accepts `!42`; GitHub accepts `58`; Bitbucket Cloud accepts `42`, `#42`, `workspace/repo#42`, `workspace/repo/pull-requests/42`, and `https://bitbucket.org/workspace/repo/pull-requests/42`.
- If a bundle already exists, `prepare` refreshes it and detects code or thread changes since the last recorded review state.
- If the current git branch no longer matches the bundled PR/MR source branch, `prepare` stops and asks you to switch branches or run `clean`.
- Thread IDs such as `T-001` are derived from the provider's thread creation order. They stay stable unless existing provider threads are deleted.
- Resolved review threads are exported to `.revpack/resolved-threads/` as context and can still receive replies by `T-NNN` ID.

Local mode:

- `revpack prepare --local` reviews committed branch changes against an inferred base branch (`origin/main`, `main`, `origin/master`, `master`, `origin/develop`, `develop`, `origin/trunk`, or `trunk`).
- Uncommitted working tree changes are ignored and are not included in the agent context.
- Local findings are stored as local review threads under `.revpack/local/` and appear in the normal `.revpack/threads/T-NNN.*` files after refresh.
- `revpack publish findings`, `revpack publish replies`, `revpack publish note`, and `revpack publish checkpoint` work against the active local bundle. Publishing the checkpoint records the local review state.

## `checkout <ref>`

Switches to a PR/MR source branch, or clones it when run outside a git repository, then prepares the `.revpack/` bundle.

```bash
revpack checkout !42
revpack checkout !42 --setup
revpack checkout !42 --repo group/project --profile myprofile
revpack checkout https://gitlab.example.com/group/project/-/merge_requests/42
revpack checkout https://github.com/user/project/pull/58
revpack checkout https://bitbucket.org/workspace/repo/pull-requests/42
revpack checkout workspace/repo#42 --profile myBitbucket
```

Notes:

- In an existing repo, `checkout` requires a clean working tree.
- For GitLab MRs whose source branch was deleted, `checkout` can fall back to `refs/merge-requests/<iid>/head` while GitLab still exposes it. GitLab 16.6 and newer removes that MR head ref 14 days after the MR is merged or closed.
- `--prepare` is still accepted for compatibility, but prepare now runs by default.
- By default, clones use HTTPS.
- To clone with SSH, set `sshClone: true` in the profile. Git handles SSH keys and passphrase prompts as usual.

## `status [ref]`

Shows PR/MR state, branches, bundle freshness, local checkout status, agent outputs, and publish history.

```bash
revpack status
revpack status !42
revpack status https://bitbucket.org/workspace/repo/pull-requests/42
revpack status !42 --json
```

When a bundle exists, `status` reads from `.revpack/bundle.json`. Otherwise, it fetches from the provider API.
The bundle section shows the PR/MR head commit that was reviewed and the checkout commit captured at prepare time.
The publish history section reports earlier `revpack publish` actions recorded in the bundle; `status` itself does not publish anything.

## `publish`

Publishes agent outputs back to the PR/MR.

```bash
revpack publish all
revpack publish replies
revpack publish findings
revpack publish summary
revpack publish note
revpack publish checkpoint
revpack publish summary --repo workspace/repo
```

After publishing, revpack refreshes the bundle by default so the new provider comments are reflected locally.
This publish-triggered refresh preserves other pending output files; run `revpack prepare` explicitly when you want stale replies pruned against the latest thread state. Replies to resolved threads are preserved as long as the provider still returns the thread.
Missing default queue files such as `.revpack/outputs/replies.json` and `.revpack/outputs/new-findings.json` are treated as having no pending items.
Malformed queue files stop guided publish before any material or checkpoint is selected.

Bare `revpack publish` starts the guided publish flow for choosing review material and checkpoint state.
`revpack publish description` is kept as a compatibility alias for `revpack publish summary`.
`revpack publish note` publishes `.revpack/outputs/note.md` as a visible review note. `revpack publish review` remains a compatibility alias for the same file.
`revpack publish checkpoint` records review state for future incremental runs.

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
revpack setup --agent claude
revpack setup --agent codex
revpack setup --agent cursor
revpack setup --agent copilot
revpack setup agent claude
revpack setup agent codex
revpack setup agent cursor
revpack setup agent copilot
revpack setup --prompts
revpack setup --dry-run
```

`revpack setup` creates only `REVIEW.md`.
`revpack setup --agent <target>` creates `REVIEW.md` when missing and installs one agent adapter.
`revpack setup agent <target>` writes project-level instruction files for one agent target and does not create `REVIEW.md`.

`--prompts` is kept as a deprecated compatibility flag. It creates `REVIEW.md` and installs the Copilot `/revpack-review` prompt.

Generated harness files:

- `agent claude`: `.claude/skills/revpack-review/SKILL.md`
- `agent codex`: `.agents/skills/revpack-review/SKILL.md`
- `agent copilot`: `.github/prompts/revpack-review.prompt.md`
- `agent cursor`: `.cursor/commands/revpack-review.md`

## `auth`

Sets up and checks provider authentication. `auth setup` creates or updates a provider profile with settings such as the provider type, host URL, and token environment variable name. It does not store your provider token directly.

```bash
revpack auth setup
revpack auth doctor
revpack auth doctor --profile myprofile
revpack auth doctor --json
revpack auth show
revpack auth show --profile myprofile
revpack auth show --sources
revpack auth show --json
```

`revpack doctor` is a shortcut for `revpack auth doctor`.

## `config`

Inspects and edits provider profiles. Revpack stores provider settings in named profiles. Commands such as `show`, `get`, `set`, and `unset` use the profile resolved from the current git remote unless you pass `--profile`; `config profile` commands manage saved profiles directly.

```bash
# Provider authentication
revpack auth setup
revpack auth doctor
revpack auth doctor --profile myprofile
revpack auth show

# Shortcut for provider authentication checks
revpack doctor
revpack doctor --profile myprofile

# Non-interactive profile creation
revpack config profile create myBitbucket --provider bitbucket-cloud --url https://bitbucket.org --email-env REVPACK_BITBUCKET_EMAIL --token-env REVPACK_BITBUCKET_TOKEN

# Current project
revpack config show
revpack config show --profile myprofile
revpack config show --sources

# Profile values
revpack config get <key>
revpack config set <key> <value>
revpack config unset <key>

# Saved profiles
revpack config profile list
revpack config profile show <name>
revpack config profile create <name>
revpack config profile delete <name>
```

Use these options when changing profile-specific values:

```bash
--profile <name>   # target a specific profile
--current          # resolve the profile from the current git remote
```

Configurable keys:

```text
provider, url, tokenEnv, emailEnv, remotePatterns, caFile, tlsVerify, sshClone
```

- `provider` is `gitlab`, `github`, or `bitbucket-cloud`.
- `url` is the provider base URL. Bitbucket Cloud profiles must use `https://bitbucket.org`.
- `tokenEnv` names the environment variable that contains the provider token.
- `emailEnv` names the environment variable that contains the Atlassian account email. It is required for Bitbucket Cloud Basic Auth together with the API token; it is not a Bitbucket username.

`revpack auth setup` stores provider settings such as the provider type, host URL, and token environment variable name. It does not store your provider token directly.

Bitbucket Cloud support covers pull request review workflows on `bitbucket.org`. It does not include Bitbucket Server/Data Center, OAuth, workspace/project/repository access tokens, Pipelines, or commit status integrations.

> [!TIP]
> `revpack auth setup` writes profiles to: `~/.config/revpack/config.json`
