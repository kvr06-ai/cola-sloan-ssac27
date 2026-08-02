#!/bin/sh
# Deploy the driver/probe test masters into the engine fork's src/test/.
#
# The *.test.ts files in this directory are the editable MASTERS. They import
# `../worker/...`, so they only resolve (and only get picked up by vitest's
# "basketball" project) from inside zengm-fork/src/test/. Edit the master here,
# then run ./deploy.sh to sync it into the fork before running.
#
#   ./deploy.sh            # deploy every *.test.ts master
#   ./deploy.sh colaChannelProbe   # deploy one (prefix match)

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
DEST="$FORK/src/test"

if [ ! -d "$DEST" ]; then
  echo "error: $DEST not found (is the fork present?)" >&2
  exit 1
fi

PAT="${1:-}"
n=0
for f in "$DIR"/*.test.ts; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case "$base" in
    "$PAT"*|"") cp "$f" "$DEST/$base"; echo "deployed $base -> zengm-fork/src/test/"; n=$((n+1)) ;;
  esac
done
echo "$n file(s) deployed."
