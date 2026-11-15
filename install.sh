#!/usr/bin/env bash
# Install the board into the Herdr app on this computer (the laptop). The CLI goes to the server with ./deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$home/mods/herdr-board" "$home/mods/herdr-board-tabs"
cp herdr-board/mods/herdr-board/main.js herdr-board/mods/herdr-board/mod.json "$home/mods/herdr-board/"
cp herdr-board/mods/herdr-board-tabs/* "$home/mods/herdr-board-tabs/"
cp layout/board.json "$home/layouts/board.json"
# The layout's Git panel and tab-bar button open the git-graph mod (github.com/rabeeh-ta/herdr-git-graph), which is
# its own project. Point GIT_GRAPH_DIR at a clone of it (default: a "herdr-git-graph" folder next to this one).
graph="${GIT_GRAPH_DIR:-$(cd .. && pwd)/herdr-git-graph}"
if [ -d "$graph/mods/git-graph" ]; then
  rm -rf "$home/mods/git-graph"; cp -R "$graph/mods/git-graph" "$home/mods/"
  echo "installed the git-graph mod from $graph"
else
  echo "WARNING: no git-graph mod at $graph/mods/git-graph: the Git button will open an empty panel."
  echo "  Clone github.com/rabeeh-ta/herdr-git-graph and run again with GIT_GRAPH_DIR=<its folder>."
fi
skills="${CLAUDE_HOME:-$HOME/.claude}/skills"
mkdir -p "$skills/card-creator"
cp skills/card-creator/SKILL.md "$skills/card-creator/"
rm -f "$home/layouts/board-side.json"   # older versions had a second layout
echo "installed the board (mods herdr-board, herdr-board-tabs; layout board; Claude Code skill card-creator)."
echo "Pick the layout with Ctrl+Shift+L, then set the machine and paths in the board's settings (⚙)."
echo 'Optional key: add "ctrl-alt-b": "herdr-board-tabs.toggle" to "global" in keys.json.'
