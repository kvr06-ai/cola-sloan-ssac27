#!/bin/sh
# Copy the results page into a checkout of the repository that GitHub Pages
# served it from (cola-manipulation-bound, folder docs/sweep/). That repository
# is private since 28 November 2026, so the page at
# https://kvr06-ai.github.io/cola-manipulation-bound/sweep/ is no longer online.
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
