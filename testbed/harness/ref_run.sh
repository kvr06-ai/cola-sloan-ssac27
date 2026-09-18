#!/bin/sh
# Record-based reference mechanisms (the own-metric comparison Highley asked for):
#
#   ./ref_run.sh [seasons] [reps] [chunk] [conc]
#
# Same memory-safe chunked runner as e14_run.sh. Three configs:
#   nba    post-2019 NBA lottery (14-team pool, official ball counts, top-4 draw,
#          picks 5-14 by record)
#   t321a  3-2-1 proposal, NBA-style top-4 draw over tiered balls (drawDepth 4)
#   t321b  3-2-1 proposal, full 16-pick tiered draw (drawDepth 16)
# Analyze runs/ref/ together with runs/e14/ (e14_analysis.js runsDir arg works,
# but note the NBA/3-2-1 own metric is RECORD, so their help-by-own-metric gap
# equals their tanking gap by construction).

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
OUT="$DIR/runs/ref"
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

run_config nba   '{"id":840,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"nba"}'
run_config t321a '{"id":841,"E":"16-tiered","C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"t321","drawDepth":4}'
run_config t321b '{"id":842,"E":"16-tiered","C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"t321","drawDepth":16}'
wait

echo "concatenating chunks into one file per config..."
for tag in nba t321a t321b; do
  TAG="$tag" OUTDIR="$OUT" node -e '
    const fs=require("fs"), dir=process.env.OUTDIR, tag=process.env.TAG;
    const files=fs.readdirSync(dir).filter(f=>f.startsWith(tag+"_s")&&f.endsWith(".json")).sort();
    if(!files.length){console.log(tag+": no chunks"); process.exit(0);}
    const all=[].concat(...files.map(f=>JSON.parse(fs.readFileSync(dir+"/"+f))));
    fs.writeFileSync(dir+"/"+tag+".json", JSON.stringify(all));
    console.log(tag+".json: "+all.length+" reps from "+files.length+" chunks");
  '
done
echo "ref run done at $(date)"
