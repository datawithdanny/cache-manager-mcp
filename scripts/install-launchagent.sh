#!/usr/bin/env bash
#
# Install (or update / uninstall) the macOS LaunchAgent that runs the
# cache-manager notifier in the background at login.
#
# It auto-detects your Node binary and this repository's path, removes the
# legacy `com.zed.cache-manager.notifier` agent if present, renders the plist
# template with real paths, and loads the new `com.cache-manager.notifier`.
#
# Usage:
#   scripts/install-launchagent.sh            # install / update + load
#   scripts/install-launchagent.sh --uninstall  # unload + remove
#   NODE_BIN=/usr/local/bin/node scripts/install-launchagent.sh   # override node
#
set -euo pipefail

LABEL="com.cache-manager.notifier"
LEGACY_LABEL="com.zed.cache-manager.notifier"

# Resolve the repo root from this script's location (scripts/ -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
TEMPLATE="$REPO_ROOT/docs/launchagents/$LABEL.plist"
DEST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LEGACY_DEST="$LAUNCH_AGENTS_DIR/$LEGACY_LABEL.plist"
NOTIFIER="$REPO_ROOT/server/cache-manager-notifier.mjs"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this installer is macOS-only (uses launchd)." >&2
  exit 1
fi

# Best-effort unload + remove of any previously installed agent for a label.
remove_agent() {
  local label="$1" dest="$2"
  if [[ -f "$dest" ]]; then
    echo "  unloading $label"
    launchctl unload "$dest" 2>/dev/null || true
    rm -f "$dest"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Uninstalling LaunchAgents..."
  remove_agent "$LEGACY_LABEL" "$LEGACY_DEST"
  remove_agent "$LABEL" "$DEST"
  echo "Done. Notifier will no longer start at login."
  exit 0
fi

# --- Install / update ------------------------------------------------------

# Locate Node: honor $NODE_BIN, else the one on PATH, else common Homebrew spots.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && NODE_BIN="$candidate" && break
  done
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "error: could not find a node binary. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: plist template not found at $TEMPLATE" >&2
  exit 1
fi
if [[ ! -f "$NOTIFIER" ]]; then
  echo "error: notifier script not found at $NOTIFIER" >&2
  exit 1
fi

echo "Repo:     $REPO_ROOT"
echo "Node:     $NODE_BIN"
echo "Notifier: $NOTIFIER"

mkdir -p "$LAUNCH_AGENTS_DIR"

# Remove the legacy Zed-named agent and any prior install of the new one.
remove_agent "$LEGACY_LABEL" "$LEGACY_DEST"
remove_agent "$LABEL" "$DEST"

# Render the template, substituting the two placeholder paths. Use '|' as the
# sed delimiter since paths contain '/'.
sed \
  -e "s|/opt/homebrew/bin/node|$NODE_BIN|" \
  -e "s|/ABSOLUTE/PATH/TO/cache-manager/server/cache-manager-notifier.mjs|$NOTIFIER|" \
  "$TEMPLATE" >"$DEST"

echo "Wrote $DEST"

launchctl load "$DEST"
echo "Loaded $LABEL"

echo
echo "Logs:"
echo "  tail -f /tmp/cache-manager-notifier.out.log /tmp/cache-manager-notifier.err.log"
echo "Uninstall:"
echo "  $0 --uninstall"
