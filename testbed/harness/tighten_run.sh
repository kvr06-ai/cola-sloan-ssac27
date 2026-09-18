#!/bin/sh
# Memory-safe tightening run.
#
#   ./tighten_run.sh [seasons] [reps] [chunk] [conc]
#
# Each config's REPS replicates are split into CHUNK-replicate processes (the
# proven-stable ~3GB size), launched CONC at a time and resumable per chunk
# (a finished chunk's JSON is skipped on re-run), then concatenated into one
# file per config: runs/tighten/<config>.json. Analyze with the usual scripts
# pointed at runs/tighten/. Run under caffeinate for the long job.

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
OUT="$DIR/runs/tighten"
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

# Same configs and ids as the n=12 baseline (unpaired across mechanisms).
run_config g0        '{"id":810,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":0}'
run_config g1        '{"id":812,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":1}'
run_config g2        '{"id":814,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":2}'
run_config g3        '{"id":815,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":3}'
run_config classic   '{"id":820,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"'}'
run_config countdown '{"id":821,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"countdown"}'
run_config beckett   '{"id":822,"E":22,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"beckett"}'
wait

echo "concatenating chunks into one file per config..."
for tag in g0 g1 g2 g3 classic countdown beckett; do
  TAG="$tag" OUTDIR="$OUT" node -e '
    const fs=require("fs"), dir=process.env.OUTDIR, tag=process.env.TAG;
    const files=fs.readdirSync(dir).filter(f=>f.startsWith(tag+"_s")&&f.endsWith(".json")).sort();
    if(!files.length){console.log(tag+": no chunks"); process.exit(0);}
    const all=[].concat(...files.map(f=>JSON.parse(fs.readFileSync(dir+"/"+f))));
    fs.writeFileSync(dir+"/"+tag+".json", JSON.stringify(all));
    console.log(tag+".json: "+all.length+" reps from "+files.length+" chunks");
  '
done
echo "tightening done at $(date)"