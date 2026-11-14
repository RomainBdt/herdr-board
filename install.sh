#!/usr/bin/env bash
# Install the board panel into the Herdr app on this computer (the laptop).
# The CLI goes to the server with ./deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$home/mods/herdr-board"
cp mod/main.js mod/mod.json "$home/mods/herdr-board/"
cp layout/board.json "$home/layouts/board.json"
echo "installed: $home/mods/herdr-board and layouts/board.json"
echo "edit the board block's props in layouts/board.json (machine, script, board), then pick the layout with Ctrl+Shift+L"
