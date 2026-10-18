#!/usr/bin/env bash
# Rebuild `prod` = the manifest `base` (default upstream/master) + every branch listed in release/manifest.yml.
# Usage: release/rebuild-prod.sh [--dry-run] [--merge-only] [--with <branch>]... [--manifest <file>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Optional per-machine settings (PATH, HOME, gate runner). See release/README.md.
if [ -f "$SCRIPT_DIR/box-env.sh" ]; then . "$SCRIPT_DIR/box-env.sh"; fi

TOOLS_REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
MANIFEST="$SCRIPT_DIR/manifest.yml"
DRY_RUN=0
MERGE_ONLY=0
EXTRAS=()
PNPM_VERSION="9.15.4"
BUILD_DIR="${REBUILD_DIR:-$(dirname "$TOOLS_REPO")/paperclip-rebuild-prod}"
LOG_ROOT="${REBUILD_LOG_DIR:-${HOME:-/tmp}/.paperclip-rebuild-logs}"
KNOWN_FAILURES="${REBUILD_KNOWN_FAILURES:-$SCRIPT_DIR/known-failures.txt}"
# Optional executable called as: $REBUILD_GATE_RUNNER <build-dir> <pnpm args...>.
# Used for typecheck/test/build only (install always runs with network).
GATE_RUNNER="${REBUILD_GATE_RUNNER:-}"
STAMP="$(date +%Y%m%d-%H%M)"
TMP_BRANCH="rebuild/prod-$STAMP"

usage() {
  sed -n '2,3p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo "  --dry-run         do everything except moving prod"
  echo "  --merge-only      resolve the base and merge the branches, skip install and gates (implies --dry-run)"
  echo "  --with <branch>   add one extra branch to the build (implies --dry-run); repeatable"
  echo "  --manifest <file> use another manifest"
}

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date +%H:%M:%S)] $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --merge-only) MERGE_ONLY=1; DRY_RUN=1 ;;
    --with) [ $# -ge 2 ] || die "--with needs a branch name"; EXTRAS+=("$2"); DRY_RUN=1; shift ;;
    --manifest) [ $# -ge 2 ] || die "--manifest needs a file"; MANIFEST="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"

g() { git -C "$TOOLS_REPO" "$@"; }
b() { git -C "$BUILD_DIR" "$@"; }

GIT_COMMON_DIR="$(cd "$TOOLS_REPO" && cd "$(git rev-parse --git-common-dir)" && pwd)"
exec 9>"$GIT_COMMON_DIR/rebuild-prod.lock"
flock -n 9 || die "another rebuild is running (lock: $GIT_COMMON_DIR/rebuild-prod.lock)"

if [ -z "$(git config user.email || true)" ]; then
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Paperclip}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-noreply@paperclip.ing}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Paperclip}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-noreply@paperclip.ing}"
fi

pnpm_run() { # <dir> <args...>
  local dir="$1"; shift
  if command -v pnpm >/dev/null 2>&1; then (cd "$dir" && pnpm "$@")
  else (cd "$dir" && npx --yes "pnpm@$PNPM_VERSION" "$@"); fi
}
gate_run() { # <dir> <args...>
  if [ -n "$GATE_RUNNER" ]; then "$GATE_RUNNER" "$@"; else pnpm_run "$@"; fi
}

# ---- 1. read and validate the manifest -------------------------------------
ENTRIES="$(python3 - "$MANIFEST" <<'PY'
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1])) or {}
rows = doc.get("branches") or []
seen = []
for i, r in enumerate(rows, 1):
    br = (r.get("branch") or "").strip()
    kind = (r.get("kind") or "").strip()
    parent = str(r.get("parent") or "").strip()
    pr = str(r.get("pr") or "").strip()
    dep = r.get("dependsOn") or []
    if isinstance(dep, str): dep = [dep]
    def bad(msg): sys.exit(f"manifest entry {i} ({br or '?'}): {msg}")
    if not br: bad("branch is empty")
    if br in ("master", "prod", "fork-tools") or br.startswith("upstream/"): bad("reserved branch name")
    if kind not in ("upstream-request", "fork-patch"): bad("kind must be upstream-request or fork-patch")
    if not parent: bad("parent is empty")
    if br in seen: bad("duplicate branch")
    for d in dep:
        if d not in seen: bad(f"dependsOn {d} must be listed earlier")
    seen.append(br)
    print("\t".join([br, kind, parent, pr, ",".join(dep)]))
PY
)" || die "manifest is not valid"

# `base` is the upstream point prod is built on. `baseCommit` pins it when `base` is a name that is not a git ref
# (a beta npm release has no git tag). Missing `base` means upstream/master.
BASE_FIELDS="$(python3 - "$MANIFEST" <<'PY'
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1])) or {}
print(str(doc.get("base") or "").strip() + "\t" + str(doc.get("baseCommit") or "").strip())
PY
)" || die "manifest is not valid"
IFS=$'\t' read -r BASE_NAME BASE_COMMIT <<<"$BASE_FIELDS"
[ -n "$BASE_NAME" ] || [ -z "$BASE_COMMIT" ] || die "baseCommit needs base"
[ -n "$BASE_NAME" ] || BASE_NAME="upstream/master"

BRANCHES=(); REFS=()
while IFS=$'\t' read -r br kind parent pr dep; do
  [ -n "$br" ] || continue
  BRANCHES+=("$br")
done <<<"$ENTRIES"
for x in "${EXTRAS[@]+"${EXTRAS[@]}"}"; do
  for br in "${BRANCHES[@]+"${BRANCHES[@]}"}"; do [ "$br" != "$x" ] || die "--with $x is already in the manifest"; done
  BRANCHES+=("$x")
done

# ---- 2. fetch and resolve --------------------------------------------------
log "fetch upstream and origin"
g fetch upstream --quiet
g fetch origin --tags --quiet
if [ -n "$BASE_COMMIT" ]; then
  BASE_SHA="$(g rev-parse --verify -q "$BASE_COMMIT^{commit}")" || die "baseCommit $BASE_COMMIT not found (fetch upstream)"
  NAMED_SHA="$(g rev-parse --verify -q "$BASE_NAME^{commit}" || true)"
  [ -z "$NAMED_SHA" ] || [ "$NAMED_SHA" = "$BASE_SHA" ] \
    || die "base $BASE_NAME is ${NAMED_SHA:0:9} but baseCommit is ${BASE_SHA:0:9}; fix the manifest"
else
  BASE_SHA="$(g rev-parse --verify -q "$BASE_NAME^{commit}")" || die "base $BASE_NAME not found"
fi
g merge-base --is-ancestor "$BASE_SHA" upstream/master \
  || die "base $BASE_NAME (${BASE_SHA:0:9}) is not part of upstream/master"
BASE_LABEL="$BASE_NAME ${BASE_SHA:0:9}"
log "base: $BASE_LABEL"

for br in "${BRANCHES[@]+"${BRANCHES[@]}"}"; do
  if g rev-parse --verify -q "refs/remotes/origin/$br" >/dev/null; then REFS+=("refs/remotes/origin/$br")
  elif [ "$DRY_RUN" = 1 ] && g rev-parse --verify -q "refs/heads/$br" >/dev/null; then
    log "WARNING: $br is not on origin; using the local branch (trial build only)"; REFS+=("refs/heads/$br")
  else die "branch $br is not on origin. Push it first."; fi
  if g merge-base --is-ancestor "${REFS[${#REFS[@]}-1]}" "$BASE_SHA"; then
    log "WARNING: $br is already part of the base ($BASE_LABEL). Remove it from the manifest."
  fi
done

# ---- 3. build worktree -----------------------------------------------------
if [ -e "$BUILD_DIR" ]; then
  [ "$(cd "$BUILD_DIR" && cd "$(git rev-parse --git-common-dir)" && pwd)" = "$GIT_COMMON_DIR" ] \
    || die "$BUILD_DIR exists and is not a worktree of this repository"
  b merge --abort 2>/dev/null || true
  b reset --hard -q
  b clean -fdxq -e node_modules
  b checkout -q -B "$TMP_BRANCH" "$BASE_SHA"
else
  g worktree add -q -B "$TMP_BRANCH" "$BUILD_DIR" "$BASE_SHA"
fi
g for-each-ref --format='%(refname:short)' refs/heads/rebuild/ | grep -vxF "$TMP_BRANCH" | xargs -r git -C "$TOOLS_REPO" branch -D -q || true
log "build dir: $BUILD_DIR (branch $TMP_BRANCH from $BASE_LABEL)"

RUN_LOG="$LOG_ROOT/$STAMP"; mkdir -p "$RUN_LOG"
SUMMARY=()

print_summary() {
  echo "---- rebuild summary ($STAMP) ----"
  echo "base:   $BASE_LABEL"
  echo "merged: ${MERGED[*]:-none}"
  local built="${BUILD_SHA:-none}"; echo "build:  ${built:0:9}"
  printf 'gate:   %s\n' "${SUMMARY[@]+"${SUMMARY[@]}"}"
  echo "logs:   $RUN_LOG"
}

# ---- 4. merge in order, stop on the first conflict --------------------------
MERGED=()
for i in "${!BRANCHES[@]}"; do
  br="${BRANCHES[$i]}"; ref="${REFS[$i]}"
  # A branch is rebased on upstream/master (that is how its pull request stays current). When the base is older
  # than that (a beta), merging the branch would pull in every newer upstream commit and silently change the base.
  # Then take only the branch's own commits: those not in upstream/master.
  OWN_ALL="$(g rev-list --count "upstream/master..$ref")"
  AHEAD="$(g rev-list --count "$BASE_SHA..$ref")"
  if [ "$AHEAD" -gt "$OWN_ALL" ]; then
    mapfile -t OWN < <(g rev-list --reverse --no-merges "upstream/master..$ref")
    [ ${#OWN[@]} -gt 0 ] || die "$br has no commits of its own on top of upstream/master"
    log "pick $br (${#OWN[@]} own commit(s); the branch is based on newer upstream than $BASE_LABEL)"
    ACTION=(cherry-pick "${OWN[@]}")
  else
    log "merge $br"
    ACTION=(merge --no-ff -q -m "Merge $br into prod build" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>" "$ref")
  fi
  if ! b "${ACTION[@]}" >"$RUN_LOG/merge-$i.log" 2>&1; then
    FILES="$(b diff --name-only --diff-filter=U)"
    OTHERS=()
    for j in "${!MERGED[@]}"; do
      prior="${MERGED[$j]}"; prior_ref="${REFS[$j]}"
      touched="$(g diff --name-only "$(g merge-base upstream/master "$prior_ref")" "$prior_ref")"
      if [ -n "$(comm -12 <(sort <<<"$FILES") <(sort <<<"$touched"))" ]; then OTHERS+=("$prior"); fi
    done
    b merge --abort 2>/dev/null || true
    b cherry-pick --abort 2>/dev/null || true
    echo "CONFLICT while merging $br" >&2
    if [ ${#OTHERS[@]} -gt 0 ]; then echo "  $br conflicts with: ${OTHERS[*]}" >&2
    else echo "  $br conflicts with the base $BASE_LABEL (rebase it on the base)" >&2; fi
    echo "  files:" >&2; sed 's/^/    /' <<<"$FILES" >&2
    echo "prod was NOT moved." >&2
    exit 2
  fi
  MERGED+=("$br")
done
BUILD_SHA="$(b rev-parse HEAD)"
log "merged ${#MERGED[@]} branch(es); build commit ${BUILD_SHA:0:9}"

if [ "$MERGE_ONLY" = 1 ]; then
  print_summary
  echo "merge only: no gates run, prod NOT moved."
  exit 0
fi

# ---- 5. gates --------------------------------------------------------------
log "pnpm install"
# CI=1: when the base changes, pnpm asks "reinstall the modules from scratch?"; without a terminal it skips the install and
# leaves node_modules from the previous build. CI=1 makes it answer yes.
CI=1 pnpm_run "$BUILD_DIR" install --frozen-lockfile >"$RUN_LOG/install.log" 2>&1 \
  || CI=1 pnpm_run "$BUILD_DIR" install --no-frozen-lockfile >"$RUN_LOG/install.log" 2>&1 \
  || die "pnpm install failed (see $RUN_LOG/install.log)"
b checkout -q -- pnpm-lock.yaml 2>/dev/null || true

run_gate() { # <name> <pnpm args...>
  local name="$1"; shift
  local start; start=$(date +%s)
  log "gate $name: pnpm $*"
  if gate_run "$BUILD_DIR" "$@" >"$RUN_LOG/$name.log" 2>&1; then
    SUMMARY+=("$name pass $(( $(date +%s) - start ))s"); return 0
  fi
  if [ "$name" = test ] && tolerated_failures_only "$RUN_LOG/$name.log"; then
    SUMMARY+=("$name pass-with-known-failures $(( $(date +%s) - start ))s"); return 0
  fi
  SUMMARY+=("$name FAIL $(( $(date +%s) - start ))s")
  echo "GATE FAILED: $name (log: $RUN_LOG/$name.log). prod was NOT moved." >&2
  tail -n 40 "$RUN_LOG/$name.log" >&2
  print_summary >&2
  exit 3
}

# Failed test names from a test log, normalized to "|package| file > test name" (colored or plain logs).
failed_tests() {
  sed -E 's/\x1b\[[0-9;]*m//g' "$1" | grep -E '^ *FAIL ' \
    | sed -E 's/^ *FAIL +\|?([^| ]+)\|? +/|\1| /; s/ +[0-9]+ms$//' | sort -u
}

# True when the test log lists failures and every one is in the known-failures file,
# or its test file passes when run alone (load flakes: a file that needs 10 minutes alone can fail
# by timeout when the whole suite runs on a busy machine).
tolerated_failures_only() {
  local failed; failed="$(failed_tests "$1")"
  [ -n "$failed" ] || return 1
  local known=/dev/null; [ -f "$KNOWN_FAILURES" ] && known="$KNOWN_FAILURES"
  local unknown; unknown="$(comm -23 <(printf '%s\n' "$failed") <(grep -vE '^\s*(#|$)' "$known" | sort -u))"
  [ -z "$unknown" ] && return 0
  echo "Failures not in known-failures; re-running their files alone:" >&2; printf '%s\n' "$unknown" | cut -c1-200 >&2
  local pairs; pairs="$(printf '%s\n' "$unknown" | sed -E 's/^\|([^|]+)\| ([^ ]+).*/\1 \2/' | sort -u)"
  local pkg file n=0
  while read -r pkg file; do
    [ -n "$file" ] || return 1
    n=$((n + 1))
    log "re-run alone: $pkg $file"
    gate_run "$BUILD_DIR" --filter "$pkg" exec vitest run "$file" >"$RUN_LOG/rerun-$n.log" 2>&1 \
      || { echo "still failing alone: $pkg $file (log: $RUN_LOG/rerun-$n.log)" >&2; return 1; }
  done <<<"$pairs"
  return 0
}


run_gate typecheck -r typecheck
run_gate test test:run
run_gate build build

# ---- 6. move prod ----------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  print_summary
  echo "dry run: prod NOT moved."
  exit 0
fi

OLD_SHA="$(g rev-parse --verify -q refs/remotes/origin/prod || true)"
if [ "$OLD_SHA" = "$BUILD_SHA" ]; then
  print_summary
  echo "prod is already at this build. Nothing to move."
  exit 0
fi
TAG="prod-$STAMP"
if [ -n "$OLD_SHA" ]; then
  g rev-parse --verify -q "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists; wait one minute and retry"
  g tag "$TAG" "$OLD_SHA"
  g push -q origin "refs/tags/$TAG"
  log "previous prod ${OLD_SHA:0:9} saved as tag $TAG"
  g push -q origin "$BUILD_SHA:refs/heads/prod" --force-with-lease="refs/heads/prod:$OLD_SHA"
else
  g push -q origin "$BUILD_SHA:refs/heads/prod"
fi
g branch -f prod "$BUILD_SHA" 2>/dev/null || log "local prod branch is checked out elsewhere; not updated"
b checkout -q --detach
g branch -D "$TMP_BRANCH" -q 2>/dev/null || true

print_summary
echo "prod moved: ${OLD_SHA:-none} -> $BUILD_SHA"
echo "deploy card: base $BASE_LABEL; branches ${MERGED[*]:-none}; new prod ${BUILD_SHA:0:9}; previous prod ${OLD_SHA:0:9}"
echo "rollback:   git push origin refs/tags/${TAG}:refs/heads/prod --force-with-lease=refs/heads/prod:$BUILD_SHA   (then reinstall)"
