#!/bin/sh
# Detached, sleep-proof, resumable full-engine COLA sweep launcher.
#
#   ./run_sweep.sh [name] [concurrency] [chunk-size]
#
# Runs the full 50-config x 50-replicate x 30-season sweep through the parallel,
# resumable runner in sweep.js. Detaches from the terminal (nohup) so it survives
# the shell / Claude session closing, and holds off idle sleep (caffeinate). It
# writes each (config, seed-chunk) unit to its own CSV the moment it finishes, so
# an interruption costs only the in-flight units. RE-RUN WITH THE SAME NAME TO
# RESUME -- finished units are skipped.
#
# Defaults:
#   name        fullengine_<timestamp>
#   concurrency 12   (~24h on a 16-core M3 Max; leaves ~4 cores for normal use.
#                     Use 8 for a snappier machine at ~36h, or 14 for ~21h.)
#   chunk-size  5    (<= ~35 min of work lost per interrupted unit)
#
# Caveat: caffeinate prevents IDLE sleep on AC power, but closing a laptop lid
# still sleeps the machine (and pauses the run) unless in clamshell mode
# (external display + power). Keep the lid open, on AC.
#
# Watch:   tail -f runs/<name>/sweep.log
# Results: runs/<name>/sweep.csv   (rebuilt as units finish; valid mid-run)
# Stop:    pkill -f 'sweep.js --parallel'

DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:-fullengine_$(date +%Y%m%d_%H%M%S)}"
CONC="${2:-12}"
CHUNK="${3:-5}"
OUT="$DIR/runs/$NAME"
mkdir -p "$OUT"

nohup caffeinate -is env COLA_FULL_ENGINE=1 node "$DIR/sweep.js" \
  --parallel --name "$NAME" --config-id all --replicates 50 \
  --concurrency "$CONC" --chunk-size "$CHUNK" \
  >> "$OUT/sweep.log" 2>&1 &
PID=$!

echo "Sweep launched."
echo "  PID:         $PID  (name=$NAME, concurrency=$CONC, chunk=$CHUNK)"
echo "  watch:       tail -f $OUT/sweep.log"
echo "  results:     $OUT/sweep.csv   (rebuilt as units finish)"
echo "  resume:      ./run_sweep.sh $NAME $CONC $CHUNK   (after a crash/sleep)"
echo "  stop:        pkill -f 'sweep.js --parallel'"
