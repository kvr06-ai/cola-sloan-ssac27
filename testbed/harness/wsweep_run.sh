#!/bin/sh
# Lottery-weighting (W) sweep runner.
#
#   ./wsweep_run.sh [seasons] [reps] [concurrency]
#
# One vitest process per config (all reps in that process), launched in waves of
# `concurrency` to bound memory, with a short stagger to desync peaks. Resumable:
# a config whose runs/wsweep/<tag>.json already exists is skipped, so re-running
# fills in only what is missing. Analyze with wsweep_analysis.js.
#
# Defaults: 15 seasons, 12 replicates, 3-way. Run under caffeinate for long jobs:
#   caffeinate -is ./wsweep_run.sh 15 12 3

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
SEASONS="${1:-15}"
REPS="${2:-12}"
CONC="${3:-3}"
NAME="${4:-wsweep}"
OUT="$DIR/runs/$NAME"
mkdir -p "$OUT"
# Build a valid JSON seed list. (BSD `seq -s,` appends a trailing comma, which is
# invalid JSON; paste joins without one.)
SEEDS="[$(seq 0 $((REPS - 1)) | paste -sd, -)]"
cd "$FORK"

# Common dials for the weighted family and the Classic reference (E/C/S are
# ignored by the variants; they are the Classic dials for the no-variant run).
launched=0
run_one() {
  tag="$1"; cfg="$2"
  if [ -f "$OUT/$tag.json" ]; then echo "skip $tag (already done)"; return; fi
  COLA_DRIVER_CONFIG="$cfg" COLA_DRIVER_REPLICATES="$SEEDS" COLA_DRIVER_OUTPUT="$OUT/$tag.json" \
    "$FORK/node_modules/.bin/vitest" --run --project basketball src/test/colaFullEngineDriver.test.ts \
    > "$OUT/$tag.log" 2>&1 &
  echo "launch $tag (pid $!)"
  launched=$((launched + 1))
  sleep 8  # stagger memory peaks
  if [ $((launched % CONC)) -eq 0 ]; then echo "  -- wave barrier --"; wait; fi
}

# Weighting family: P(draft order over eligible pool) proportional to cola^gamma.
# Coarse pass spans flat -> steep; intermediate gammas are a refinement.
run_one g0   "{\"id\":810,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"weighted\",\"gamma\":0}"
run_one g1   "{\"id\":812,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"weighted\",\"gamma\":1}"
run_one g2   "{\"id\":814,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"weighted\",\"gamma\":2}"
run_one g3   "{\"id\":815,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"weighted\",\"gamma\":3}"
# Reference points: status-quo Classic cola, and the two named anchors.
run_one classic   "{\"id\":820,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS}"
run_one countdown "{\"id\":821,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"countdown\"}"
run_one beckett   "{\"id\":822,\"E\":22,\"C\":null,\"S\":\"unbounded\",\"seasons\":$SEASONS,\"variant\":\"beckett\"}"

wait
echo "wsweep done at $(date). Analyze:"
echo "  node wsweep_analysis.js g0=runs/wsweep/g0.json g1=runs/wsweep/g1.json g2=runs/wsweep/g2.json g3=runs/wsweep/g3.json classic=runs/wsweep/classic.json countdown=runs/wsweep/countdown.json beckett=runs/wsweep/beckett.json"