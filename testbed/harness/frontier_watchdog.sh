#!/bin/sh
# Watchdog for the frontier sweep. Acts on memory and disk without a human.
#
#   nohup ./frontier_watchdog.sh [lanes=3] [seasons=25] [reps=30] [chunk=6] >> runs/frontier/watchdog.log 2>&1 &
#
# Every 60 seconds it samples swap in use, free memory and free disk. Policy:
#   swap    above SWAP_MB and higher than the previous sample by RISE_MB or more:
#           stop the runner and its vitest workers, relaunch at one lane fewer
#           (floor 1). A killed chunk leaves no JSON, so the relaunch redoes it.
#   disk    free space below DISK_GB: stop the run and exit, no relaunch.
#   runner  exited with fewer than EXPECTED chunk files: relaunch at the current
#           lane count, at most MAX_RETRY times.
#   done    all EXPECTED chunk files present: exit. frontier_run.sh concatenates
#           on its own normal exit.
# Every line is timestamped; interventions are marked ACTION, the end COMPLETE or
# STOP. Read: tail -f runs/frontier/watchdog.log

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/runs/frontier"
LANES="${1:-3}"
SEASONS="${2:-25}"
REPS="${3:-30}"
CHUNK="${4:-6}"
CONFIGS=9
SWAP_MB=3500
RISE_MB=100
DISK_GB=10
MAX_RETRY=2
PERIOD=60
HEARTBEAT_EVERY=10   # samples between progress lines

per_config=$(( (REPS + CHUNK - 1) / CHUNK ))
EXPECTED=$(( per_config * CONFIGS ))

log() { printf "%s %s\n" "$(date '+%m-%d %H:%M:%S')" "$*"; }
swap_mb() { sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | cut -d. -f1; }
disk_gb() { df -g / | awk 'NR==2 {print $4}'; }
mem_line() { top -l 1 -n 0 | grep PhysMem | sed 's/PhysMem: //'; }
done_count() { ls "$OUT"/*_s*.json 2>/dev/null | wc -l | tr -d ' '; }
runner_alive() { pgrep -f "frontier_run.sh" >/dev/null 2>&1; }

stop_run() {
  pkill -f "caffeinate -is ./frontier_run.sh" 2>/dev/null
  pkill -f "frontier_run.sh" 2>/dev/null
  pkill -f "vitest --run --project basketball src/test/colaFullEngineDriver.test.ts" 2>/dev/null
  sleep 5
  pkill -9 -f "vitest --run --project basketball src/test/colaFullEngineDriver.test.ts" 2>/dev/null
  sleep 2
  log "stopped: runner alive=$(runner_alive && echo yes || echo no), vitest procs=$(pgrep -f 'colaFullEngineDriver' | wc -l | tr -d ' ')"
}
start_run() {
  cd "$DIR" || exit 1
  nohup caffeinate -is ./frontier_run.sh "$SEASONS" "$REPS" "$CHUNK" "$LANES" >> "$OUT/console.log" 2>&1 &
  sleep 3
  log "started runner at $LANES lane(s), pid $(pgrep -f 'sh ./frontier_run.sh' | head -1)"
}

prev_swap=$(swap_mb)
retries=0
i=0
start_epoch=$(date +%s)
log "watchdog up: expecting $EXPECTED chunk files, lanes=$LANES, swap trigger >${SWAP_MB}MB rising >=${RISE_MB}MB, disk floor ${DISK_GB}GB, done=$(done_count)"

while :; do
  i=$((i + 1))
  swap=$(swap_mb); disk=$(disk_gb); done=$(done_count)

  if [ "$done" -ge "$EXPECTED" ]; then
    # let the runner finish its concatenation, then leave
    n=0; while runner_alive && [ $n -lt 60 ]; do sleep 5; n=$((n + 1)); done
    log "COMPLETE: $done/$EXPECTED chunks; concatenated files: $(ls "$OUT"/*.json 2>/dev/null | grep -vc '_s[0-9]')"
    exit 0
  fi

  if [ "$disk" -lt "$DISK_GB" ]; then
    log "ACTION disk: ${disk}GB free below ${DISK_GB}GB; stopping the run"
    stop_run
    log "STOP: run halted for disk space at $done/$EXPECTED chunks; relaunch by hand after freeing space"
    exit 2
  fi

  if [ "$swap" -gt "$SWAP_MB" ] && [ $((swap - prev_swap)) -ge "$RISE_MB" ] && runner_alive; then
    if [ "$LANES" -gt 1 ]; then
      LANES=$((LANES - 1))
      log "ACTION memory: swap ${swap}MB (was ${prev_swap}MB); restarting at $LANES lane(s) [$(mem_line)]"
      stop_run
      start_run
      prev_swap=$(swap_mb)
      sleep "$PERIOD"
      continue
    else
      log "memory: swap ${swap}MB rising at 1 lane already; holding [$(mem_line)]"
    fi
  fi

  if ! runner_alive; then
    if [ "$retries" -lt "$MAX_RETRY" ]; then
      retries=$((retries + 1))
      log "ACTION runner exited at $done/$EXPECTED chunks; relaunch $retries/$MAX_RETRY at $LANES lane(s)"
      start_run
    else
      log "STOP: runner exited at $done/$EXPECTED chunks after $MAX_RETRY relaunches; look at the newest chunk logs in $OUT"
      exit 3
    fi
  fi

  if [ $((i % HEARTBEAT_EVERY)) -eq 0 ]; then
    elapsed=$(( $(date +%s) - start_epoch ))
    if [ "$done" -gt 0 ]; then
      eta_min=$(( elapsed * (EXPECTED - done) / done / 60 ))
    else
      eta_min="?"
    fi
    log "progress $done/$EXPECTED chunks, lanes=$LANES, swap ${swap}MB, disk ${disk}GB, eta ~${eta_min} min [$(mem_line)]"
  fi

  prev_swap=$swap
  sleep "$PERIOD"
done
