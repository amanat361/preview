#!/usr/bin/env bash
# Installs (or removes) preview: the CLI into ~/.local/bin and, on Omarchy, the bar widget.
#
#   ./install.sh              build + install both
#   ./install.sh --cli        only the CLI
#   ./install.sh --uninstall  remove everything this script added
#
# Touches exactly: ~/.local/bin/preview, ~/.config/omarchy/plugins/amanat361.preview/,
# one entry in ~/.config/omarchy/shell.json (via `omarchy plugin enable`), and
# ~/.local/state/preview/ (written by the CLI itself). Safe to run again; nothing piles up.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PLUGIN_ID="amanat361.preview"
BIN="$HOME/.local/bin/preview"
PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$PLUGIN_ID"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/preview"

has_omarchy() { command -v omarchy >/dev/null 2>&1 && [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy" ]; }

uninstall() {
  if has_omarchy; then
    omarchy plugin disable "$PLUGIN_ID" >/dev/null 2>&1 || true
    rm -rf "$PLUGIN_DIR"
    omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
  fi
  rm -f "$BIN"
  rm -rf "$STATE_DIR"
  echo "removed $BIN, $PLUGIN_DIR, $STATE_DIR"
}

install_cli() {
  command -v bun >/dev/null 2>&1 || { echo "bun is required to build: https://bun.sh" >&2; exit 1; }
  (cd cli && bun install --silent && bun build --compile --minify src/index.ts --outfile dist/preview >/dev/null)
  mkdir -p "$(dirname "$BIN")"
  install -m 755 cli/dist/preview "$BIN"
  echo "cli:    $BIN"
  case ":$PATH:" in *":$(dirname "$BIN"):"*) ;; *) echo "note: $(dirname "$BIN") is not on your PATH" ;; esac
}

install_plugin() {
  has_omarchy || { echo "plugin: skipped (no Omarchy here)"; return; }
  local existed=0; [ -d "$PLUGIN_DIR" ] && existed=1
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"
  cp manifest.json Panel.qml Service.qml Model.js "$PLUGIN_DIR/"
  omarchy plugin validate "$PLUGIN_DIR" >/dev/null
  if ! grep -q "\"$PLUGIN_ID\"" "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/shell.json" 2>/dev/null; then
    omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
    omarchy plugin enable "$PLUGIN_ID" --section right >/dev/null
    echo "plugin: $PLUGIN_DIR (added to the bar, right section)"
  elif [ "$existed" = 1 ]; then
    # the shell caches loaded QML; copying over an existing plugin does not reliably reload it
    omarchy restart shell >/dev/null 2>&1 || true
    echo "plugin: $PLUGIN_DIR (updated, shell restarted)"
  else
    omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
    echo "plugin: $PLUGIN_DIR (refreshed)"
  fi
}

case "${1:-}" in
  --uninstall) uninstall ;;
  --cli) install_cli ;;
  "") install_cli; install_plugin ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
