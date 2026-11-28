#!/bin/sh
# Run frontier_run.sh under a memory guard, with a progress line every minute.
#
#   nohup sh ./rerun_guarded.sh [lanes=3] [ceil_gb=16] >> runs/frontier/rerun.log 2>&1 &
#
# frontier_run.sh skips every chunk whose JSON already exists, so this re-runs
# only the configs whose chunk files have been moved away (for example into
# runs/frontier/superseded/). The guard exists because the machine does other
# work: a fault in the run must end the run and nothing else.
#   start   refuses if a frontier run or a driver process is already going.
#   guard   every 60 s it adds up the memory of the run's vitest processes and
#           stops the run if that passes CEIL_GB, or if swap in use has grown by
#           SWAP_RISE_MB or more since the start.
#   log     one line a minute: seasons finished (from the .progress files the
#           driver appends to), chunk files written, memory, swap.
# Exit: 0 when the runner finishes, 2 when the guard stopped it.

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/runs/frontier"
LANES="${1:-3}"
CEIL_GB="${2:-16}"
SWAP_RISE_MB=2000
PERIOD=60

log() { printf "%s %s\n" "$(date '+%m-%d %H:%M:%S')" "$*"; }
swap_mb() { sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | cut -d. -f1; }
run_mb() { ps -axo rss,command | awk '/vitest/ && !/awk/ {s += $1} END {printf "%d", s / 1024}'; }
free_line() { top -l 1 -n 0 | grep PhysMem | sed 's/PhysMem: //'; }
seasons_done() { cat "$OUT"/*.progress 2>/dev/null | wc -l | tr -d ' '; }
chunks_done() { ls "$OUT"/*_s*.json 2>/dev/null | wc -l | tr -d ' '; }

if pgrep -f "frontier_run.sh" >/dev/null 2>&1 || pgrep -f "colaFullEngineDriver" >/dev/null 2>&1; then
  log "REFUSED: a frontier run or a driver process is already going"
  exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT"/*.progress
cd "$DIR" || exit 1
chunks0=$(chunks_done)
swap0=$(swap_mb)
nohup caffeinate -is sh ./frontier_run.sh 25 30 6 "$LANES" >> "$OUT/console.log" 2>&1 &
RUNNER=$!
log "START runner pid $RUNNER, lanes=$LANES, memory ceiling ${CEIL_GB} GB, swap at start ${swap0} MB, chunk files present $chunks0 [$(free_line)]"

stop_run() {
  pkill -f "frontier_run.sh" 2>/dev/null
  pkill -f "vitest --run --project basketball src/test/colaFullEngineDriver.test.ts" 2>/dev/null
  sleep 5
  pkill -9 -f "colaFullEngineDriver" 2>/dev/null
  pkill -9 -f "frontier_run.sh" 2>/dev/null
}

start=$(date +%s)
while kill -0 "$RUNNER" 2>/dev/null; do
  sleep "$PERIOD"
  mb=$(run_mb); swap=$(swap_mb)
  mins=$(( ( $(date +%s) - start ) / 60 ))
  log "progress: seasons $(seasons_done), new chunk files $(( $(chunks_done) - chunks0 )), run memory $(( mb / 1024 )).$(( (mb % 1024) * 10 / 1024 )) GB, swap ${swap} MB, ${mins} min elapsed"
  if [ "$mb" -gt $(( CEIL_GB * 1024 )) ]; then
    log "GUARD STOP: run memory ${mb} MB passed the ${CEIL_GB} GB ceiling"
    stop_run; exit 2
  fi
  if [ $(( swap - swap0 )) -ge "$SWAP_RISE_MB" ]; then
    log "GUARD STOP: swap grew from ${swap0} MB to ${swap} MB"
    stop_run; exit 2
  fi
done
log "DONE: runner exited after $(( ( $(date +%s) - start ) / 60 )) min; seasons $(seasons_done), new chunk files $(( $(chunks_done) - chunks0 ))"
