#!/usr/bin/env node
// Own-metric #1-vs-#5 expected-pick gaps, computed from the tightening-run data.
// Implements the unified scoring proposed in the Highley correspondence: rank each
// mechanism by its OWN priority metric and report the gap between the top-priority
// team and the fifth.
//   leg(a) tanking : rank lottery-eligible teams by THIS-SEASON wins (ASC), gap = pick[5th]-pick[worst].  want ~0
//   leg(b) help    : rank the SAME teams by the COLA index colaPre (DESC), gap = pick[5th]-pick[top].     want large
// Both are [5th]-[1st]; positive => the #1 team drafts ahead of the #5 team.
//
// Run from this directory:  node own_metric_gaps.js [runsDir]   (default runs/tighten)
const fs = require("fs");
const { rankOneToFiveSpread } = require("./objectives.js");
const dir = process.argv[2] || "runs/tighten";
const mechs = ["g0", "classic", "g1", "g2", "g3", "countdown", "beckett"];

function rankByIndexSpread(seasonLog) {
  const N = 5, sums = new Array(N).fill(0); let n = 0;
  for (const e of seasonLog) {
    const elig = e.teams.filter(t => t.draftPick != null).slice()
      .sort((a, b) => (b.colaPre ?? b.cola ?? 0) - (a.colaPre ?? a.cola ?? 0)); // highest index = rank 1
    if (elig.length < N) continue;
    for (let i = 0; i < N; i++) sums[i] += elig[i].draftPick;
    n++;
  }
  if (!n) return NaN;
  const exp = sums.map(s => s / n);
  return exp[N - 1] - exp[0];
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const sem = a => sd(a) / Math.sqrt(a.length);
const load = t => JSON.parse(fs.readFileSync(`${dir}/${t}.json`, "utf8")).map(r => r.seasonLog);
const TC = 2.01; // t_{0.975, df=47}
const ci = a => `[${(mean(a) - TC * sem(a)).toFixed(2)}, ${(mean(a) + TC * sem(a)).toFixed(2)}]`;

console.log(`n=${(() => { try { return load(mechs[0]).length; } catch { return "?"; } })()} reps each.  gap = expected pick of 5th-priority team minus 1st-priority team.\n`);
console.log(`mech        leg(a) tanking (rank by wins, want ~0)     leg(b) help (rank by index, want large)`);
console.log("-".repeat(92));
for (const m of mechs) {
  const L = load(m);
  const a = L.map(s => rankOneToFiveSpread(s).spread1To5).filter(x => !isNaN(x));
  const b = L.map(rankByIndexSpread).filter(x => !isNaN(x));
  const tag = (m === "countdown" || m === "beckett") ? " *" : "";
  console.log(`${(m + tag).padEnd(10)}  ${mean(a).toFixed(2).padStart(6)}  ${ci(a).padEnd(16)}            ${mean(b).toFixed(2).padStart(6)}  ${ci(b)}`);
}
console.log(`\n* countdown/beckett ranked by the COLA index as a proxy; their native metric is drought x wins (not captured per-team).`);
