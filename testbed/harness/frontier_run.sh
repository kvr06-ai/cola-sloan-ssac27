#!/bin/sh
# Frontier run: the named mechanisms on a 25-season horizon.
#
#   ./frontier_run.sh [seasons] [reps] [chunk] [conc]
#
# Requested by the first author for the SSAC27 abstract: a longer horizon at
# fewer leagues (30 leagues x 25 seasons per mechanism, about the season count
# of the 48 x 15 runs) so that the long-term-parity criterion, the longest
# drought any team has between playoff-series wins, resolves inside the run.
# Same memory-safe chunked runner as e14_run.sh. Nine configs, in the order the
# results are needed:
#   classic    Classic COLA, 14-team pool (engine lottery: top-4 by index, 5-14 by record)
#   waitlist   Waitlist COLA, 14-team pool (top-4 by index, 5-14 by index)
#   nba        post-2019 NBA lottery (official ball counts, top-4 draw, 5-14 by record)
#   t321       3-2-1 AS ADOPTED (roles 3/7/4/2 at 2/3/2/1 balls, all 16 drawn,
#              pick-12 floor for the worst three, no repeat #1, no third straight top-5)
#   countdown  Countdown COLA (named anchor)
#   beckett    Beckett COLA (named anchor)
#   simple     Simple COLA, 22-team pool ordered by index, no draw (Classic's index dynamics)
#   full       full-depth lottery by index over the 14-team pool (gamma 1)
#   uniform    uniform lottery over the 14-team pool (gamma 0), the no-tanking benchmark
# Capped COLA is NOT in this run: the harness cap clamps the engine index in
# engine units, which does not reproduce the wins-based increment of the
# published variant.
#
# All nine share config id 900, so a given seed builds the SAME initial league
# under every mechanism (the seed hash reads the id); the histories separate at
# the first draw. Cross-mechanism comparisons can therefore be made per seed.
# Analyze runs/frontier/ with frontier_analysis.js.

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
OUT="$DIR/runs/frontier"
SEASONS="${1:-25}"
REPS="${2:-30}"
CHUNK="${3:-6}"
CONC="${4:-3}"
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
  echo "launch ${tag}_s${lo}-${hi} (pid $!) at $(date +%H:%M:%S)"
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

S="$SEASONS"
run_config classic   '{"id":900,"E":14,"C":null,"S":"unbounded","seasons":'"$S"'}'
run_config waitlist  '{"id":900,"E":14,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"weighted","gamma":1,"lotteryDepth":4}'
run_config nba       '{"id":900,"E":14,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"nba"}'
run_config t321      '{"id":900,"E":"16-tiered","C":null,"S":"unbounded","seasons":'"$S"',"variant":"t321","adopted":true}'
run_config countdown '{"id":900,"E":22,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"countdown"}'
run_config beckett   '{"id":900,"E":22,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"beckett"}'
run_config simple    '{"id":900,"E":22,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"weighted","gamma":1,"lotteryDepth":0}'
run_config full      '{"id":900,"E":14,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"weighted","gamma":1}'
run_config uniform   '{"id":900,"E":14,"C":null,"S":"unbounded","seasons":'"$S"',"variant":"weighted","gamma":0}'
wait

echo "concatenating chunks into one file per config..."
for tag in classic waitlist nba t321 countdown beckett simple full uniform; do
  TAG="$tag" OUTDIR="$OUT" node -e '
    const fs=require("fs"), dir=process.env.OUTDIR, tag=process.env.TAG;
    const files=fs.readdirSync(dir).filter(f=>f.startsWith(tag+"_s")&&f.endsWith(".json")).sort();
    if(!files.length){console.log(tag+": no chunks"); process.exit(0);}
    const all=[].concat(...files.map(f=>JSON.parse(fs.readFileSync(dir+"/"+f))));
    fs.writeFileSync(dir+"/"+tag+".json", JSON.stringify(all));
    console.log(tag+".json: "+all.length+" reps from "+files.length+" chunks");
  '
done
echo "frontier run done at $(date)"
