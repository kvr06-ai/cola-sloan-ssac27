#!/bin/sh
# Sim 3, behavioral arm: a real tank inside the full engine, run against its own
# control.
#
#   ./tank_run.sh [seasons] [tankSeasonIndex] [rank] [reps] [chunk] [conc]
#
# Six runs, three mechanisms times two arms. In the tank arm the team sitting
# `rank` places off the bottom of the standings at the season's midpoint sits its
# five best players for the rest of the year and the engine plays the season out.
# The control arm runs the identical split and sits nobody. Both arms of a
# mechanism share a config id, so a given seed builds the same league, plays the
# same games, and the two histories separate only at the shutdown.
#
# This is the piece the counterfactual in tank_counterfactual.js cannot supply.
# The counterfactual moves a record and holds everything else fixed, which
# isolates the draft rule exactly but assumes a tank changes nothing else. A real
# tank also hands wins to other teams, which can change who makes the playoffs
# and therefore who is in the lottery pool at all. Running it in the engine
# measures the draft consequence with that second-order traffic included.
#
# Analyze with: node tank_engine.js

DIR="$(cd "$(dirname "$0")" && pwd)"
FORK="$DIR/zengm-fork"
OUT="$DIR/runs/tank"
SEASONS="${1:-8}"
TANKSEASON="${2:-6}"
RANK="${3:-5}"
REPS="${4:-48}"
CHUNK="${5:-12}"
CONC="${6:-4}"
VITEST="$FORK/node_modules/.bin/vitest"
mkdir -p "$OUT"
"$DIR/deploy.sh" colaFullEngineDriver
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

# The two arms of a mechanism differ ONLY in how many players are sat, so they
# must share a config id: that is what makes them the same league.
arm() {  # players
  echo '"tank":{"season":'"$TANKSEASON"',"rank":'"$RANK"',"players":'"$1"'}'
}
for P in 5 0; do
  [ "$P" = 5 ] && A=tank || A=ctrl
  run_config "nba_$A"      '{"id":850,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"nba",'"$(arm $P)"'}'
  run_config "classic_$A"  '{"id":851,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"','"$(arm $P)"'}'
  run_config "waitlist_$A" '{"id":852,"E":14,"C":null,"S":"unbounded","seasons":'"$SEASONS"',"variant":"weighted","gamma":1,"lotteryDepth":4,'"$(arm $P)"'}'
done
wait

echo "concatenating chunks into one file per run..."
for tag in nba_tank nba_ctrl classic_tank classic_ctrl waitlist_tank waitlist_ctrl; do
  TAG="$tag" OUTDIR="$OUT" node -e '
    const fs=require("fs"), dir=process.env.OUTDIR, tag=process.env.TAG;
    const files=fs.readdirSync(dir).filter(f=>f.startsWith(tag+"_s")&&f.endsWith(".json")).sort();
    if(!files.length){console.log(tag+": no chunks"); process.exit(0);}
    const all=[].concat(...files.map(f=>JSON.parse(fs.readFileSync(dir+"/"+f))));
    all.sort((a,b)=>a.seed-b.seed);
    fs.writeFileSync(dir+"/"+tag+".json", JSON.stringify(all));
    console.log(tag+".json: "+all.length+" reps from "+files.length+" chunks");
  '
done
echo "tank run done at $(date)"
