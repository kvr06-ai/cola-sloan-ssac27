#!/bin/sh
# E=14 rerun + middle option (pressure-test sims 1 and 2).
#
#   ./e14_run.sh [seasons] [reps] [chunk] [conc]
#
# Same memory-safe chunked runner as tighten_run.sh, at Highley's canonical
# eligibility E=14 (the 14 non-playoff teams) instead of the 22-team pool the
# headline sweep standardized on. Six configs:
#   classic  Classic COLA at E=14 (engine cola lottery: top-4 by index, 5-14 by record)
#   g0..g3   full-depth weighted lottery (cola^gamma over the 14) at E=14
#   mid      MIDDLE OPTION: top-4 lottery by index, picks 5-14 by index (not record)
# Analyze runs/e14/ with the usual scripts (own_metric_gaps.js, stats_tests.js).

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
OUT="$DIR/runs/e14"
SEASONS="${1:-15}"
REPS="${2:-48}"
CHUNK="${3:-12}"
CONC="${4:-4}"
VITEST="$FORK/node_modules/.bin/vitest"
mkdir -p "$OUT"
cd "$FORK"

launched=0
unit() {  # tag lo hi cfgjson
  tag="$1"; lo="$2"; hi="$3"; cfg="$4"
  out="$OUT/${tag}_s${lo}-${hi}.json"
  if [ -f "$out" ]; then echo "skip ${tag}_s${lo}-${hi} (done)"; return; fi
  seeds="[$(seq "$lo" "$hi" | paste -sd, -)]"
  COLA_DRIVER_CONFIG="$cfg" COLA_DRIVER_REPLICATES="$seeds" COLA_DRIVER_OUTPUT="$out" \
    "$VITEST" --run --project basketball src/test/colaFullEngineDriver.test.ts \
    > "$OUT/${tag}_s${lo}-${hi}.log" 2>&1 &
  echo "launch ${tag}_s${lo}-${hi} (pid $!)"
  launched=$((launched + 1))
  sleep 6
  if [ $((launched % CONC)) -eq 0 ]; then echo "  -- barrier --"; wait; fi
}
run_config() {  # tag cfgjson
  tag="$1"; cfg="$2"; lo=0
  while [ "$lo" -lt "$REPS" ]; do
    hi=$((lo + CHUNK - 1)); [ "$hi" -ge "$REPS" ] && hi=$((REPS - 1))
    unit "$tag" "$lo" "$hi" "$cfg"
    lo=$((hi + 1))
  done
}

run_config classic '{"id":830,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"'}'
run_config g0      '{"id":831,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":0}'
run_config g1      '{"id":832,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":1}'
run_config g2      '{"id":833,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":2}'
run_config g3      '{"id":834,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":3}'
run_config mid     '{"id":835,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":1,"lotteryDepth":4}'
wait

echo "concatenating chunks into one file per config..."
for tag in classic g0 g1 g2 g3 mid; do
  TAG="$tag" OUTDIR="$OUT" node -e '
    const fs=require("fs"), dir=process.env.OUTDIR, tag=process.env.TAG;
    const files=fs.readdirSync(dir).filter(f=>f.startsWith(tag+"_s")&&f.endsWith(".json")).sort();
    if(!files.length){console.log(tag+": no chunks"); process.exit(0);}
    const all=[].concat(...files.map(f=>JSON.parse(fs.readFileSync(dir+"/"+f))));
    fs.writeFileSync(dir+"/"+tag+".json", JSON.stringify(all));
    console.log(tag+".json: "+all.length+" reps from "+files.length+" chunks");
  '
done
echo "e14 run done at $(date)"
