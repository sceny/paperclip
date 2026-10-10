#!/bin/sh
# Run pnpm in the build dir the way the sandbox runs its tests: private network namespace
# with IPv6 loopback, as uid 1000, with the agent-injected variables removed.
# Usage: box-gate-runner.sh <build-dir> <pnpm args...>
set -eu
SANDBOX=/home/jca/.paperclip-worktrees/instances/paperclip-fork-sandbox
export REBUILD_BUILD_DIR="$1"; shift
exec unshare -rn sh -c '
  ip link set lo up
  exec unshare --user --map-user=1000 --map-group=1000 sh -c "
    . '"$SANDBOX"'/env.sh
    . '"$SANDBOX"'/clean-env.sh
    export CI=1
    cd \"\$REBUILD_BUILD_DIR\"
    exec pnpm \"\$@\"
  " sh "$@"
' sh "$@"
