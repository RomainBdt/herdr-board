#!/usr/bin/env bash
# Install the board into the Herdr app on this computer (the laptop). The CLI goes to the server with ./deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$home/mods/herdr-board" "$home/mods/herdr-board-tabs"
cp mod/main.js mod/mod.json "$home/mods/herdr-board/"
cp mod-tabs/* "$home/mods/herdr-board-tabs/"
cp layout/board.json "$home/layouts/board.json"
rm -f "$home/layouts/board-side.json"   # older versions had a second layout
echo "installed the board (mods herdr-board, herdr-board-tabs; layout board)."
echo "Pick the layout with Ctrl+Shift+L, then set the machine and paths in the board's settings (⚙)."
echo 'Optional key: add "ctrl-alt-b": "herdr-board-tabs.toggle" to "global" in keys.json.'
