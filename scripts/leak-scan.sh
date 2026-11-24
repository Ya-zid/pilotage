#!/usr/bin/env bash
# leak-scan: look for things that must never be published: credentials that look real, personal home-folder paths,
# e-mail addresses, and (when scripts/leak-patterns.txt exists) a private list of names, clients, places and
# machines. Prints file:line for every hit and exits 1 when there is any.
#
#   scripts/leak-scan.sh [DIR]     DIR = a git checkout (scans tracked + untracked, non-ignored files)
#                                  or any folder (scans every file except node_modules, .git, dist, data)
#   scripts/leak-scan.sh --package DIR   DIR = an unpacked npm package: web/dist is published, so it is scanned too
#
# File names are checked against the same patterns as the contents (docs/<client>-notes.md is a leak too).
#
# Private patterns: one extended regex per line in $PILOTAGE_LEAK_PATTERNS (default scripts/leak-patterns.txt next
# to this script). Keep that file out of anything you publish. Intended hits: scripts/leak-allowlist.txt
# (<path glob><TAB><line regex>), or $PILOTAGE_LEAK_ALLOWLIST.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE=0
if [ "${1:-}" = --package ]; then PACKAGE=1; shift; fi
TARGET="$(cd "${1:-$HERE/..}" && pwd)" || { echo "leak-scan: no such folder: ${1:-}" >&2; exit 2; }
PATTERNS_FILE="${PILOTAGE_LEAK_PATTERNS:-$HERE/leak-patterns.txt}"
ALLOW_FILE="${PILOTAGE_LEAK_ALLOWLIST:-$HERE/leak-allowlist.txt}"

# ---------------------------------------------------------------- files to scan
FILES=()
# Git mode only at the top of a work tree (a folder inside some other checkout, e.g. an ignored export, is a plain folder).
if [ "$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null)" = "$TARGET" ]; then
  while IFS= read -r -d '' f; do [ -f "$TARGET/$f" ] && [ ! -L "$TARGET/$f" ] && FILES+=("$f"); done \
    < <(git -C "$TARGET" --no-optional-locks ls-files -z --cached --others --exclude-standard)
else
  PRUNE=(-name node_modules -o -name .git -o -name data -o -name .sandbox)
  [ "$PACKAGE" = 1 ] || PRUNE+=(-o -name dist)
  while IFS= read -r -d '' f; do FILES+=("${f#./}"); done \
    < <(cd "$TARGET" && find . \( "${PRUNE[@]}" \) -prune -o -type f -print0)
fi
[ "${#FILES[@]}" -gt 0 ] || { echo "leak-scan: no files found in $TARGET" >&2; exit 2; }

# ---------------------------------------------------------------- patterns: label<TAB>regex
GENERIC=$(cat <<'EOF'
anthropic-key	sk-ant-[A-Za-z0-9_-]{20,}
openai-key	\bsk-(proj-)?[A-Za-z0-9_-]{32,}
stripe-key	\b[sr]k_live_[A-Za-z0-9]{16,}
github-token	\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}
aws-key	\b(AKIA|ASIA)[0-9A-Z]{16}\b
google-key	\bAIza[0-9A-Za-z_-]{35}
slack-token	\bxox[abprs]-[A-Za-z0-9-]{10,}
supabase-token	\bsbp_[0-9a-f]{40}
npm-token	\bnpm_[A-Za-z0-9]{32,}
groq-key	\bgsk_[A-Za-z0-9]{32,}
huggingface-token	\bhf_[A-Za-z0-9]{30,}
gitlab-token	\bglpat-[A-Za-z0-9_-]{18,}
private-key	-----BEGIN [A-Z ]*PRIVATE KEY-----
email	[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}
home-path	/home/[A-Za-z][A-Za-z0-9._-]*|/Users/[A-Za-z][A-Za-z0-9._-]*|[A-Za-z]:\\\\?Users\\\\?[A-Za-z][A-Za-z0-9._-]*
EOF
)
PRIVATE=""
if [ -f "$PATTERNS_FILE" ]; then
  PRIVATE=$(grep -v -E '^\s*(#|$)' "$PATTERNS_FILE" | sed 's/^/private\t/')
else
  echo "leak-scan: no private pattern list ($PATTERNS_FILE): only generic checks." >&2
fi

# Placeholders that are fine in paths and addresses (docs and test fixtures use them).
SAFE_HOME='^(u|x|y|you|me|user|users|alex|sam|demo|runner|someone|name|your-name|yourname|<you>|<user>|Public|Default|Shared|\.\.\.)$'
SAFE_EMAIL='@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com|github\.com|host\.com|x\.com|localhost)$|^git@'

ALLOW_GLOBS=()
ALLOW_RES=()
if [ -f "$ALLOW_FILE" ]; then
  while IFS=$'\t' read -r g r; do
    [[ -z "$g" || "$g" == \#* || -z "${r:-}" ]] && continue
    ALLOW_GLOBS+=("$g")
    ALLOW_RES+=("$r")
  done < "$ALLOW_FILE"
fi

allowed() { # file text
  local i
  for i in "${!ALLOW_GLOBS[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$1" == ${ALLOW_GLOBS[$i]} ]] && [[ "$2" =~ ${ALLOW_RES[$i]} ]]; then return 0; fi
  done
  return 1
}

# Only placeholder names in every home path / address on the line?
benign() { # label text
  local m
  shopt -s nocasematch
  case "$1" in
    home-path)
      while IFS= read -r m; do
        m="${m##*[/\\]}"
        [[ "$m" =~ $SAFE_HOME ]] || { shopt -u nocasematch; return 1; }
      done < <(grep -o -E '/home/[A-Za-z][A-Za-z0-9._-]*|/Users/[A-Za-z][A-Za-z0-9._-]*|Users\\\\?[A-Za-z][A-Za-z0-9._-]*' <<<"$2")
      shopt -u nocasematch
      return 0 ;;
    email)
      while IFS= read -r m; do
        [[ "$m" =~ $SAFE_EMAIL ]] || { shopt -u nocasematch; return 1; }
      done < <(grep -o -E '(git@)?[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' <<<"$2")
      shopt -u nocasematch
      return 0 ;;
  esac
  shopt -u nocasematch
  return 1
}

hits=0
report() { # file line label text
  local text="${4//$'\r'/}"
  [ "${#text}" -gt 160 ] && text="${text:0:157}..."
  printf '%s:%s: [%s] %s\n' "$1" "$2" "$3" "$text"
  hits=$((hits + 1))
}

cd "$TARGET" || exit 2
BIN_FILES=()
for f in "${FILES[@]}"; do
  [ -s "$f" ] && ! grep -I -q . -- "$f" 2>/dev/null && BIN_FILES+=("$f")
done
while IFS=$'\t' read -r label re; do
  [ -n "${re:-}" ] || continue
  case_flag=()
  [ "$label" = private ] && case_flag=(-i)
  # text files
  while IFS= read -r hit; do
    file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; text="${rest#*:}"
    [ "$file" = "scripts/leak-scan.sh" ] && [ "$label" != private ] && continue # its own generic regexes
    benign "$label" "$text" && continue
    allowed "$file" "$text" && continue
    report "$file" "$line" "$label${case_flag:+: $re}" "$text"
  done < <(printf '%s\0' "${FILES[@]}" | xargs -0 grep -n -I -H "${case_flag[@]}" -E -e "$re" -- 2>/dev/null)
  # file names
  while IFS= read -r f; do
    benign "$label" "$f" && continue
    allowed "$f" "$f" && continue
    report "$f" "-" "file name, $label${case_flag:+: $re}" "$f"
  done < <(printf '%s\n' "${FILES[@]}" | grep "${case_flag[@]}" -E -e "$re")
  # binary files (images, icons): private patterns only, e.g. a path or a name in PNG metadata
  if [ "$label" = private ] && [ "${#BIN_FILES[@]}" -gt 0 ]; then
    while IFS= read -r f; do
      report "$f" "-" "private: $re" "(binary file content)"
    done < <(printf '%s\0' "${BIN_FILES[@]}" | xargs -0 grep -a -l -i -E -e "$re" -- 2>/dev/null)
  fi
done <<<"$GENERIC"$'\n'"$PRIVATE"

if [ "$hits" -gt 0 ]; then
  echo "leak-scan: $hits hit(s) in $TARGET" >&2
  exit 1
fi
echo "leak-scan: clean ($TARGET, ${#FILES[@]} files)"
