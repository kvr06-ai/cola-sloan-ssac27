#!/bin/sh
# Parallel draft-to-outcome channel probe runner.
#
#   ./probe_run.sh [seasons] [reps]
#
# Launches the `random`-variant driver across seed chunks, one vitest process
# per chunk (memory peaks staggered), and writes per-chunk JSON to runs/probe/.
# Analyze with: node channel_probe.js runs/probe/probe_c*.json --lag K
#
# Defaults: 15 seasons, 12 replicates (4 chunks x 3 seeds). Detaches nothing;
# run it under nohup/caffeinate yourself for long jobs:
#   caffeinate -is ./probe_run.sh 15 12

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
OUT="$DIR/runs/probe"
SEASONS="${1:-15}"
REPS="${2:-12}"
CHUNKS=4
mkdir -p "$OUT"
rm -f "$OUT"/probe_c*.json "$OUT"/probe_c*.log

# Split 0..REPS-1 into CHUNKS contiguous seed lists.
per=$(( (REPS + CHUNKS - 1) / CHUNKS ))
cd "$FORK"
i=0
chunk=0
while [ "$i" -lt "$REPS" ]; do
  seeds=""
  j=0
  while [ "$j" -lt "$per" ] && [ "$i" -lt "$REPS" ]; do
    seeds="${seeds}${seeds:+,}$i"
    i=$(( i + 1 )); j=$(( j + 1 ))
  done
  COLA_DRIVER_CONFIG="{\"id\":900,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"random\"}" \
  COLA_DRIVER_REPLICATES="[$seeds]" \
  COLA_DRIVER_OUTPUT="$OUT/probe_c$chunk.json" \
  "$FORK/node_modules/.bin/vitest" --run --project basketball src/test/colaFullEngineDriver.test.ts \
    > "$OUT/probe_c$chunk.log" 2>&1 &
  echo "chunk $chunk: seeds [$seeds] -> probe_c$chunk.json (pid $!)"
  chunk=$(( chunk + 1 ))
  sleep 15   # stagger memory peaks across chunks
done
wait
echo "all $chunk chunks done at $(date)"