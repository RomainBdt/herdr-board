#!/usr/bin/env bash
# Install the board into the Herdr app on this computer (the laptop). The CLI goes to the server with ./deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$home/mods/herdr-board" "$home/mods/herdr-board-tabs"
cp herdr-board/mods/herdr-board/main.js herdr-board/mods/herdr-board/mod.json "$home/mods/herdr-board/"
cp herdr-board/mods/herdr-board-tabs/* "$home/mods/herdr-board-tabs/"
mkdir -p "$home/layouts"
# The layout is merged, not copied: blocks you added to its "panel-body" stack stay (each one is a tab bar button).
if [ ! -f "$home/layouts/board.json" ]; then
  cp layout/board.json "$home/layouts/board.json"
elif command -v node >/dev/null 2>&1; then
  node layout/merge-layout.mjs layout/board.json "$home/layouts/board.json"
else
  cp layout/board.json "$home/layouts/board.json.new"
  echo "warning: node not found, so layouts/board.json was left as it is (it may hold panels you added)." >&2
  echo "         The new layout is in layouts/board.json.new: install Node and run ./install.sh again, or merge it by hand." >&2
fi
skills="${CLAUDE_HOME:-$HOME/.claude}/skills"
mkdir -p "$skills/card-creator"
cp skills/card-creator/SKILL.md "$skills/card-creator/"
rm -f "$home/layouts/board-side.json"   # older versions had a second layout
echo "installed the board (mods herdr-board, herdr-board-tabs; layout board; Claude Code skill card-creator)."
echo "Pick the layout with Ctrl+Shift+L, then set the machine and paths in the board's settings (⚙)."
echo 'Optional key: add "ctrl-alt-b": "herdr-board-tabs.toggle" to "global" in keys.json.'
echo 'More panels: add a block to "panel-body" in layouts/board.json (props label, icon); "herdr-board-tabs.<its id>" opens it.'
