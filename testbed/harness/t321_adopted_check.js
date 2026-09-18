// Checks a run of the adopted 3-2-1 arm against the rules it claims to implement.
//
//   node t321_adopted_check.js <run.json>
//
// For every league-season in the file: the sixteen pool teams (per conference
// the eight worst records) hold picks 1-16 and every other team picks 17-30;
// each of the three worst records league-wide holds a pick no later than 12;
// no team holds the #1 pick in consecutive seasons; no team holds a top-five
// pick in three consecutive seasons. Exits 1 on the first violation.

const fs = require("fs");
const file = process.argv[2];
if (!file) {
  console.error("usage: node t321_adopted_check.js <run.json>");
  process.exit(2);
}
const reps = JSON.parse(fs.readFileSync(file, "utf8"));
let seasons = 0;
let floorBinds = 0;
let repeatOneBlocks = 0;
let topFiveBlocks = 0;
let recordTails = 0; // seasons whose picks 5-16 sit in record order, the proposal arm's signature
const fail = (msg) => {
  console.error("VIOLATION: " + msg);
  process.exit(1);
};

for (const rep of reps) {
  const hist = {}; // tid -> picks by season
  rep.seasonLog.forEach((s, si) => {
    seasons += 1;
    const teams = s.teams;
    const byConf = {};
    for (const t of teams) (byConf[t.conf] ??= []).push(t);
    const pool = [];
    for (const c of Object.values(byConf)) {
      pool.push(...c.slice().sort((a, b) => a.wins - b.wins).slice(0, 8));
    }
    const poolTids = new Set(pool.map((t) => t.tid));
    for (const t of teams) {
      const inPool = poolTids.has(t.tid);
      if (t.draftPick === null) fail(`seed ${rep.seed} season ${si}: tid ${t.tid} has no pick`);
      if (inPool && t.draftPick > 16) fail(`seed ${rep.seed} season ${si}: pool tid ${t.tid} picked ${t.draftPick}`);
      if (!inPool && t.draftPick <= 16) fail(`seed ${rep.seed} season ${si}: non-pool tid ${t.tid} picked ${t.draftPick}`);
    }
    // All sixteen positions are drawn, so picks 5-16 should almost never sit in
    // record order. The proposal arm (top-four draw, rest by record) puts them
    // there every season, which is how a stale deploy of the driver shows up.
    const tail = pool.slice().sort((a, b) => a.draftPick - b.draftPick).slice(4);
    if (tail.every((t, i) => i === 0 || t.wins >= tail[i - 1].wins)) recordTails += 1;
    // Floor: the three worst records among the ten non-play-in teams.
    const nonPlayIn = [];
    for (const c of Object.values(byConf)) {
      nonPlayIn.push(...c.slice().sort((a, b) => a.wins - b.wins).slice(0, 5));
    }
    const bottom3 = nonPlayIn.slice().sort((a, b) => a.wins - b.wins).slice(0, 3);
    for (const t of bottom3) {
      if (t.draftPick > 12) fail(`seed ${rep.seed} season ${si}: bottom-three tid ${t.tid} picked ${t.draftPick}`);
      if (t.draftPick >= 10) floorBinds += 1;
    }
    // Consecutive-season rules.
    for (const t of teams) {
      const h = hist[t.tid] ?? [];
      const last = h[h.length - 1];
      const prev = h[h.length - 2];
      if (last === 1 && t.draftPick === 1) fail(`seed ${rep.seed} season ${si}: tid ${t.tid} took #1 twice running`);
      if (last !== undefined && last <= 5 && prev !== undefined && prev <= 5 && t.draftPick <= 5) {
        fail(`seed ${rep.seed} season ${si}: tid ${t.tid} took a third straight top-five pick`);
      }
      if (last === 1 && poolTids.has(t.tid)) repeatOneBlocks += 1;
      if (last !== undefined && last <= 5 && prev !== undefined && prev <= 5 && poolTids.has(t.tid)) topFiveBlocks += 1;
      (hist[t.tid] ??= []).push(t.draftPick);
    }
  });
}
if (seasons >= 4 && recordTails > seasons / 2) {
  fail(`picks 5-16 sit in record order in ${recordTails} of ${seasons} seasons; this is the proposal arm, not the adopted draw`);
}
console.log(
  `OK: ${reps.length} leagues, ${seasons} seasons. ` +
    `Seasons with picks 5-16 in record order: ${recordTails} (a full draw makes this rare). ` +
    `Bottom-three teams landing at picks 10-12: ${floorBinds}. ` +
    `Situations where the repeat-#1 rule applied to a pool team: ${repeatOneBlocks}; ` +
    `where the three-straight top-five rule applied: ${topFiveBlocks} (rules held in every case).`,
);
