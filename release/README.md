# Release tooling

`prod` is a **built** branch: `upstream/master` plus every branch in `manifest.yml`, merged in order.
Never commit to `prod` by hand. This branch (`fork-tools`) never goes upstream and never merges into `prod`.

Use a worktree for this branch: `git worktree add ../paperclip-wt-fork-tools fork-tools`.

## Add or remove a branch

Edit `release/manifest.yml` and commit to `fork-tools`. One entry per branch, in merge order:

```yaml
branches:
  - branch: fix/some-change        # branch on origin (the fork)
    kind: upstream-request         # or: fork-patch
    parent: PAP-123                # Paperclip parent task
    pr: https://github.com/paperclipai/paperclip/pull/1   # empty until a PR is open
    dependsOn: [fix/other-change]  # optional; must be listed earlier
```

Remove the entry when upstream has merged the change or the change is dropped.

## Rebuild

```sh
release/rebuild-prod.sh                       # build, test, then move prod
release/rebuild-prod.sh --dry-run             # everything except moving prod
release/rebuild-prod.sh --with fix/new-thing  # trial: manifest + one extra branch (always a dry run)
```

Steps: fetch `upstream` and `origin`; start `rebuild/prod-<stamp>` from `upstream/master` in a separate
worktree (`paperclip-rebuild-prod` next to the clone, or `$REBUILD_DIR`); merge each branch in order;
install; `pnpm -r typecheck`; `pnpm test:run`; `pnpm build`. `pnpm` is used if installed, otherwise
`npx pnpm@9.15.4`.

- **Conflict:** the script stops at the first one, names the two branches and the files, and leaves `prod` alone.
  Exit code 2. Fix it on the later branch.
- **Gate failure:** `prod` stays. Exit code 3. Logs are in `$REBUILD_LOG_DIR/<stamp>/` (default `~/.paperclip-rebuild-logs`).
- **Success, real run:** the current `origin/prod` is tagged `prod-<YYYYMMDD-HHMM>` and pushed as a tag, then
  `prod` is force-updated with `--force-with-lease`. This is the one allowed force update, because `prod` is a build
  output. Old builds survive as tags. The script prints the rollback command.
- Only one rebuild runs at a time (lock file in the git directory).

Known failures that come from this machine, not from the code, are listed one per line in
`release/known-failures.txt` (the text after `FAIL` in the test output). A test run passes only if every failing
test is on that list. Keep the list short and say why each line is there.

## Roll back

```sh
git fetch origin --tags
git push origin refs/tags/prod-<YYYYMMDD-HHMM>:refs/heads/prod --force-with-lease=refs/heads/prod:<sha of the bad build>
```

Then reinstall on the machine. The install and restart are **not** in this script; they belong to the
production-update procedure.

## This machine

`box-env.sh` is sourced automatically. It sets `HOME`, `PATH`, and a gate runner (`box-gate-runner.sh`) that runs
typecheck, test and build in a private network namespace with IPv6 loopback and without the variables agent runs inject.
Install always runs with network. Other machines can delete both files.
