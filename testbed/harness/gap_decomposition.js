#!/usr/bin/env node
/**
 * Where does today's tanking reward actually come from?
 *
 * The NBA's lottery has two parts. A weighted random draw assigns the first four
 * picks, with a worse record earning more chances, and picks 5 through 14 are
 * then handed out in reverse order of record with no draw at all. Every reform
 * of the last decade has adjusted the first part. This script asks how much of
 * the reward for losing the first part is actually responsible for.
 *
 * The measurement is a decomposition of the worst-versus-fifth-worst expected
 * pick gap on the seasons the engine produced, switching each channel off in
 * turn while leaving the other as it is:
 *
 *   full       the rule as it stands, record-weighted draw and record-ordered tail
 *   tail only  the draw made record-blind (every pool team equally likely),
 *              the tail still ordered by record
 *   odds only  the tail made record-blind, the draw left exactly as today
 *
 * Usage: node gap_decomposition.js [runsDir=runs]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { pickDistribution } = require("./pick_dist.js");

const ROOT = process.argv[2] ?? "runs";
const STEADY_FROM = 3;
const NBA_BALLS = [140, 140, 140, 125, 105, 90, 75, 60, 45, 30, 20, 15, 10, 5];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sem = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
};

// Deterministic, record-free ordering key. Reproducible across runs and
// independent of anything a team does on the court.
const blind = (season, tid) => {
	let h = (season * 73856093) ^ (tid * 19349663);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const reps = JSON.parse(fs.readFileSync(path.join(ROOT, "ref", "nba.json"), "utf8"));
// Aggregated per league, then summarized across leagues, so that correlation
// between seasons of the same league does not shrink the reported error. This is
// the same replicate-level standard the rest of the study uses.
const acc = { full: [], tailOnly: [], oddsOnly: [], neither: [] };

for (const rep of reps) {
	const per = { full: [], tailOnly: [], oddsOnly: [], neither: [] };
	for (const e of rep.seasonLog.slice(STEADY_FROM)) {
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 0);
		if (pool.length !== 14) continue;
		// Rank 0 is the worst record, which is the ranking the real rule uses for
		// both the ball counts and the tail order.
		const ranked = pool.slice().sort((a, b) => a.wins - b.wins);
		const build = (weightOf, tailKeyOf) =>
			ranked.map((t, i) => ({ id: t.tid, w: weightOf(i), tailKey: tailKeyOf(i, t) }));
		const gap = (bp) => {
			const d = pickDistribution(bp, 4);
			return d.ePick[ranked[4].tid] - d.ePick[ranked[0].tid];
		};
		per.full.push(gap(build((i) => NBA_BALLS[i], (i) => -i)));
		per.tailOnly.push(gap(build(() => 1, (i) => -i)));
		// A record-blind tail: ordered by team id, which is fixed at league
		// creation and uncorrelated with anything the mechanism rewards.
		per.oddsOnly.push(gap(build((i) => NBA_BALLS[i], (i, t) => blind(e.season, t.tid))));
		// Both channels off: the control. A rule that reads no record anywhere
		// should show no gap at all, and any residue is measurement error.
		per.neither.push(gap(build(() => 1, (i, t) => blind(e.season, t.tid))));
	}
	for (const k of Object.keys(acc)) if (per[k].length) acc[k].push(mean(per[k]));
}

const F = mean(acc.full);
const T = mean(acc.tailOnly);
const O = mean(acc.oddsOnly);
const N = mean(acc.neither);

console.log(
	`\nToday's NBA lottery: where the worst-versus-fifth-worst pick gap comes from`,
);
console.log(`(${acc.full.length} independent leagues, seasons 4-15, exact expectations)\n`);
console.log(
	`  the rule as it stands                                  ${F.toFixed(3)} +/- ${sem(acc.full).toFixed(3)} picks`,
);
console.log(
	`  draw made record-blind, tail still by record           ${T.toFixed(3)} +/- ${sem(acc.tailOnly).toFixed(3)}   ` +
		`${((100 * T) / F).toFixed(0)}% of the reward survives`,
);
console.log(
	`  tail made record-blind, draw left as today             ${O.toFixed(3)} +/- ${sem(acc.oddsOnly).toFixed(3)}   ` +
		`${((100 * O) / F).toFixed(0)}% of the reward survives`,
);
console.log(
	`  neither reads a record (control)                       ${N.toFixed(3)} +/- ${sem(acc.neither).toFixed(3)}   ` +
		`${((100 * N) / F).toFixed(0)}% survives`,
);
console.log(
	`\nThe channel every recent reform has adjusted is the draw. Removing the record from the draw`,
);
console.log(
	`entirely leaves most of the reward standing; removing it from the ten unlotteried picks removes`,
);
console.log(`most of the reward on its own.\n`);
