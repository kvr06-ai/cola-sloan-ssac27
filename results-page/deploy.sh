#!/bin/sh
# Copy the results page into a checkout of the repository that GitHub Pages
# serves it from (cola-manipulation-bound, folder docs/sweep/).
# Live URL: https://kvr06-ai.github.io/cola-manipulation-bound/sweep/
#
#   ./deploy.sh [path/to/cola-manipulation-bound/docs/sweep/index.html]
#
# Without an argument it uses the sibling checkout the authors keep.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$DIR/../../context/cola-manipulation-bound/docs/sweep/index.html}"
cp "$DIR/index.html" "$DEST"
echo "Copied index.html -> $DEST"
echo "Commit + push cola-manipulation-bound to go live (Pages serves main:/docs)."
