#!/bin/sh
# Copy the canonical simulator page to the public Pages location.
# Live URL: https://kvr06-ai.github.io/cola-manipulation-bound/sweep/
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$DIR/../../cola-manipulation-bound/docs/sweep/index.html"
cp "$DIR/index.html" "$DEST"
echo "Copied index.html -> $DEST"
echo "Commit + push cola-manipulation-bound to go live (Pages serves main:/docs)."
