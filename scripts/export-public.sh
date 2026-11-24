#!/usr/bin/env bash
# export-public: build a clean, publishable copy of this repository in a new folder, with a single commit and no
# history. It never pushes and never creates a remote.
#
#   scripts/export-public.sh [--replace] [TARGET]
#       TARGET defaults to ~/pilotage-public. It must be new or empty, or a failed earlier run. A finished earlier
#       export is only replaced with --replace (it wipes that folder, including any commits made there since).
#
# 1. Copies the repository's files (tracked + new, non-ignored; uncommitted edits as they are on disk) minus EXCLUDE.
# 2. Runs scripts/leak-scan.sh on the copy (with the private pattern list when there is one) and stops on any hit.
# 3. git init + ONE commit. Author and committer: $GIT_AUTHOR_NAME (else `git config user.name`) and
#    $GIT_AUTHOR_EMAIL, else <id>+<login>@users.noreply.github.com from `gh api user`. Your configured e-mail is
#    never used. The commit message is $PILOTAGE_EXPORT_MESSAGE, else "Pilotage <version>".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPLACE=0
if [ "${1:-}" = --replace ]; then REPLACE=1; shift; fi
TARGET="${1:-$HOME/pilotage-public}"
MARKER=".pilotage-export-in-progress"

# Never published: personal history, private lists, and audit notes (they list problems that may not be fixed yet).
EXCLUDE=(
  'AUDIT.md'
  'BUILD-LOG.md'
  'web/REVIEW-UX.md'
  'server/local-workspaces.json'
  'scripts/leak-patterns.txt'
  'data/*'
  '.sandbox/*'
  '.claude/*'
  'node_modules/*'
  'web/node_modules/*'
  'web/dist/*'
  '*.log'
  '*.pem'
  '*.key'
  '.env'
  '.env.*'
)

die() { echo "export-public: $*" >&2; exit 1; }
excluded() {
  local p
  for p in "${EXCLUDE[@]}"; do
    # shellcheck disable=SC2053
    [[ "$1" == $p ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------- target
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
case "$TARGET" in "$ROOT" | "$ROOT"/*) [[ "$TARGET" == "$ROOT/.sandbox"* ]] || die "the target must be outside the repository: $TARGET" ;; esac
if [ -n "$(ls -A "$TARGET")" ]; then
  if [ -f "$TARGET/$MARKER" ] || { [ "$REPLACE" = 1 ] && [ -f "$TARGET/.git/pilotage-export" ]; }; then
    find "$TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  elif [ -f "$TARGET/.git/pilotage-export" ]; then
    die "$TARGET holds an earlier export. Run with --replace to wipe it and export again."
  else
    die "$TARGET is not empty (and not an earlier export). Pick another folder."
  fi
fi
touch "$TARGET/$MARKER"

# ---------------------------------------------------------------- copy
n=0
while IFS= read -r -d '' f; do
  [ -f "$ROOT/$f" ] && [ ! -L "$ROOT/$f" ] || continue # deleted on disk, or a symlink
  excluded "$f" && continue
  mkdir -p "$TARGET/$(dirname "$f")"
  cp -p "$ROOT/$f" "$TARGET/$f"
  n=$((n + 1))
done < <(git -C "$ROOT" --no-optional-locks ls-files -z --cached --others --exclude-standard)
echo "export-public: copied $n files to $TARGET"

# ---------------------------------------------------------------- leak scan (the copy, not the source)
if ! bash "$ROOT/scripts/leak-scan.sh" "$TARGET"; then
  die "leak scan found the hits above. Fix them in $ROOT (or allow-list intended ones in scripts/leak-allowlist.txt) and run again. Nothing was committed."
fi

# ---------------------------------------------------------------- one commit
NAME="${GIT_AUTHOR_NAME:-$(git -C "$ROOT" config user.name || true)}"
[ -n "$NAME" ] || die "no author name: set GIT_AUTHOR_NAME"
EMAIL="${GIT_AUTHOR_EMAIL:-}"
if [ -z "$EMAIL" ]; then
  command -v gh >/dev/null 2>&1 || die "set GIT_AUTHOR_EMAIL (e.g. <id>+<login>@users.noreply.github.com), or log in with the gh CLI"
  GH_ID="$(gh api user --jq .id 2>/dev/null || true)"
  GH_LOGIN="$(gh api user --jq .login 2>/dev/null || true)"
  [ -n "$GH_ID" ] && [ -n "$GH_LOGIN" ] || die "gh api user failed: set GIT_AUTHOR_EMAIL instead"
  EMAIL="${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
fi
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$TARGET/package.json" | head -1)"
MESSAGE="${PILOTAGE_EXPORT_MESSAGE:-Pilotage ${VERSION:-0.1.0}}"

rm -f "$TARGET/$MARKER"
cd "$TARGET"
# An inherited GIT_DIR / GIT_WORK_TREE (inside a git hook, some worktree setups) would point `git init` and
# `git config` below at the source repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
git init -q -b main
# Repo-local identity, so later commits in this copy never pick up a personal global e-mail either.
git config user.name "$NAME"
git config user.email "$EMAIL"
git config commit.gpgsign false
touch .git/pilotage-export
git add -A
GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
  git commit -q -m "$MESSAGE"
echo "export-public: $(git log --oneline | wc -l | tr -d ' ') commit in $TARGET by $NAME <$EMAIL>: $(git log -1 --format=%s)"
echo "export-public: not pushed. Review it, then create the GitHub repository and push from $TARGET yourself."
