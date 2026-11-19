#!/usr/bin/env bash
# Install the npm package the way a user would and check that it runs: npm pack (builds the web app), a global
# install into a temp prefix, a temp HOME (data must land in ~/.pilotage), start, health check, status, stop.
# On macOS also `pilotage install` / `uninstall` (the LaunchAgent). Used by CI on Linux and macOS.
#
#   scripts/smoke-npm.sh          needs `npm ci` and `npm ci --prefix web` first
#
# Runs on its own port with no AI, no phone forwarder and an empty home: your own Pilotage is not touched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=4791
export PILOTAGE_PORT=$PORT PILOTAGE_LAN_INTERNAL_PORT=$((PORT - 1)) PILOTAGE_NO_AI=1 PILOTAGE_NO_FORWARDER=1 PILOTAGE_NO_RELAY_WATCH=1
unset PILOTAGE_DATA PILOTAGE_TERMINAL
step() { printf '\n== %s\n' "$*"; }
cleanup() { pilotage stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }

step "npm pack"
tarball="$(cd "$ROOT" && npm pack --silent --pack-destination "$TMP" | tail -n 1)"
tar -tzf "$TMP/$tarball" | sed 's#^package/##' | sort >"$TMP/files.txt"
for f in bin/pilotage server/index.js web/dist/index.html windows/forwarder.js README.md LICENSE; do
  grep -qx "$f" "$TMP/files.txt" || { echo "missing from the package: $f"; exit 1; }
done
if grep -E '^(data|tests|scripts|web/src|node_modules)/' "$TMP/files.txt"; then echo "unexpected files in the package"; exit 1; fi
echo "$(wc -l <"$TMP/files.txt") files, $(du -k "$TMP/$tarball" | cut -f1) KB"

step "npm install -g (temp prefix)"
npm install -g --silent --no-audit --no-fund --prefix "$TMP/prefix" "$TMP/$tarball"
export PATH="$TMP/prefix/bin:$PATH"
export HOME="$TMP/home"
mkdir -p "$HOME"
trap cleanup EXIT
command -v pilotage

step "pilotage version / start"
pilotage version
pilotage start
curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q '"app":"pilotage"'
test -f "$HOME/.pilotage/secrets.json" || { echo "data is not in ~/.pilotage"; exit 1; }
pilotage status
pilotage stop
if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo "still running after stop"; exit 1; fi

if [ "$(uname -s)" = Darwin ]; then
  step "macOS: pilotage install (LaunchAgent) / uninstall"
  pilotage install
  plist="$HOME/Library/LaunchAgents/local.pilotage.plist"
  test -f "$plist"
  plutil -lint "$plist"
  grep -q "<key>PILOTAGE_PORT</key><string>$PORT</string>" "$plist"
  curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q '"app":"pilotage"'
  launchctl print "gui/$(id -u)/local.pilotage" >/dev/null 2>&1 && echo "LaunchAgent loaded" || echo "note: LaunchAgent not loaded in this session (takes effect at login)"
  pilotage uninstall
  test ! -f "$plist"
fi
step "ok"
