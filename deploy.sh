#!/usr/bin/env bash
# Copy the board's code to the server: ./deploy.sh <machine> <folder on the server>
#   ./deploy.sh my-server D:/work/herdr-board
set -euo pipefail
machine=${1:?machine name from hc machine ls}
dest=${2:?folder on the server}
cd "$(dirname "$0")"
for f in herdr-board.mjs rules.md draft-rules.md card-template.md; do
  hc file write --on "$machine" "$dest/$f" < "$f" >/dev/null
  echo "copied $f -> $machine:$dest/$f"
done
