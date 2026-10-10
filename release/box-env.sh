# Settings for this machine only. Sourced by rebuild-prod.sh when present.
# Agent runs get a temporary HOME and no mise shims (see the Paperclip map, L4 and L15).
export HOME=/home/jca
export PATH="/home/jca/.cargo/bin:/home/jca/.local/share/mise/installs/node/26.8.1/bin:$PATH"
# typecheck/test/build run in a private network namespace with a working ::1 (agent runs have none).
export REBUILD_GATE_RUNNER="/home/jca/paperclip-wt-fork-tools/release/box-gate-runner.sh"
