# Install shims for `paperclipai install --ref`

At upstream HEAD the git-ref install flow cannot build a payload on its own (checked 2026-10-10). These two
wrappers fix that without touching any source. Install the real `corepack` first:
`npm install --prefix ~/.local/share/paperclip-fork-tools corepack` (Node 25+ ships no corepack).

Copy both files to `~/.local/share/paperclip-fork-tools/bin/`, then run the install through node, not through
`~/.local/bin/paperclipai` (that shim puts node's own bin first on PATH, so the `npm` wrapper would be skipped):

```sh
export HOME=/home/jca COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PATH=~/.local/share/paperclip-fork-tools/bin:~/.cargo/bin:~/.local/share/mise/installs/node/26.8.1/bin:$PATH
node ~/.paperclip/cli/current/node_modules/paperclipai/dist/index.js install --ref prod --repo sceny/paperclip -y
```

- `corepack`: after the server build step, does the staging that `scripts/release.sh` does: standalone packages,
  `server/ui-dist`, runtime `skills`, and one version for all public packages.
- `npm`: adds `--ignore-scripts` to `npm pack` of a staged bundled package, so `prepack` does not run in the staging dir.
- `cargo` must be on PATH (the runner binary is built from Rust).
