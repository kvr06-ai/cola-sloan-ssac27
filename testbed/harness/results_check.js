#!/usr/bin/env node
/**
 * Section 7's numbers: the nine mechanisms on the five measures of Section 6.
 *
 * Reads the nine run files in runs/frontier (30 leagues x 25 seasons each) and
 * prints:
 *
 * 1. The nine mechanisms on the five measures, as averages over the 30 leagues,
 *    then the difference of each mechanism from 3-2-1, league by league, with
 *    its 95% interval. The reward for losing and the help for a longer wait are
 *    exact expectations (measures.js), averaged over a league's 25 seasons.
 * 2. The reward for losing from every starting position: the team with the
 *    n-th worst record among the 14 that missed the playoffs drops to the worst
 *    record in the league.
 * 3. The figures behind the text: how often each mechanism rewards losing at
 *    all, the range of the longest wait across leagues, how many waits for a
 *    series win ended, and how many top-three picks went to teams that lost in
 *    the first round.
 *
 * Nothing here is sampled, so the output is identical on every run.
 *
 * Usage: node results_check.js [runsDir=runs/frontier]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const M = require("./measures.js");

const ROOT = process.argv[2] ?? "runs/frontier";

// [run file, name in measures.js, name in the paper]
const MECHS = [
	["nba", "old", "Old lottery"],
	["uniform", "uniform", "Equal-odds lottery"],
	["t321", "t321", "3-2-1"],
	["classic", "classic", "Classic COLA"],
	["waitlist", "waitlist", "Waitlist COLA"],
	["full", "full", "Full-lottery COLA"],
	["simplerule", "simple", "Simple COLA"],
	["countdown", "countdown", "Countdown COLA"],
	["beckett", "beckett", "Beckett COLA"],
];
const REFERENCE = "t321";
// Starting positions for part 2: the 2nd-worst to the 14th-worst record.
const RANKS = Array.from({ length: 13 }, (_, i) => i + 2);
const STANDARD_RANK = 5;
// A reward below this size is rounding in the arithmetic of an exact zero.
const ROUNDING = 1e-9;

const { mean } = M;
const pad = (cells, widths) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[0]) : String(c).padStart(widths[i]))).join("");
const signed = (x, d) => (Math.abs(x) < 0.5 * 10 ** -d ? (0).toFixed(d) : (x > 0 ? "+" : "") + x.toFixed(d));
const meanOf = (a) => mean(a.filter((x) => x != null));

// ---------------------------------------------------------------------------
// One pass over every league of every mechanism
// ---------------------------------------------------------------------------

const leagues = {}; // run tag -> one summary per league
for (const [tag, mech] of MECHS) {
	const reps = JSON.parse(fs.readFileSync(path.join(ROOT, `${tag}.json`), "utf8")).sort((a, b) => a.seed - b.seed);
	leagues[tag] = reps.map((rep) => {
		const league = M.fromSim(rep);
		const rewards = RANKS.map(() => []); // one list of seasons per starting position
		const help = [];
		let topThree = 0;
		let topThreeToFirstRoundLosers = 0;
		M.walk(league, (season, state) => {
			M.rewardsForLosing(mech, season, state, RANKS).forEach((r, i) => rewards[i].push(r));
			help.push(M.helpForWaiting(mech, season, state, STANDARD_RANK));
			for (const t of season.teams) {
				if (t.pick > 3) continue;
				topThree++;
				if (!t.missed && !t.wonSeries) topThreeToFirstRoundLosers++;
			}
		});
		const ended = M.waitLengths(league, (t) => t.wonSeries);
		return {
			rewards,
			topThree,
			topThreeToFirstRoundLosers,
			R: meanOf(rewards[STANDARD_RANK - 2]),
			H: meanOf(help),
			L: M.longestWait(league),
			W: mean(ended),
			ended: ended.length,
			B: mean(M.waitLengths(league, (t) => !t.missed)),
		};
	});
}
const col = (tag, key) => leagues[tag].map((v) => v[key]);

// ---------------------------------------------------------------------------
// 1. The nine mechanisms on the five measures
// ---------------------------------------------------------------------------

const MEASURES = [
	["R", "reward for losing", 2, true],
	["H", "help for a longer wait", 2, false],
	["L", "longest wait", 1, false],
	["W", "next series win", 2, false],
	["B", "return to playoffs", 2, false],
];
console.log(`\nSection 7, ${ROOT}\n`);
console.log("1. The nine mechanisms on the five measures (averages over the 30 leagues)\n");
const W1 = [20, 20, 24, 14, 18, 20];
console.log(pad(["mechanism", ...MEASURES.map((m) => m[1])], W1));
for (const [tag, , name] of MECHS) {
	console.log(pad([name, ...MEASURES.map(([key, , d, sign]) => (sign ? signed(mean(col(tag, key)), d) : mean(col(tag, key)).toFixed(d)))], W1));
}
console.log(`\nDifference from 3-2-1, league by league: mean [95% interval]; * marks an interval that excludes zero\n`);
const W1b = [20, 26, 26, 26, 26, 26];
console.log(pad(["mechanism", ...MEASURES.map((m) => m[1])], W1b));
for (const [tag, , name] of MECHS) {
	if (tag === REFERENCE) continue;
	console.log(
		pad(
			[
				name,
				...MEASURES.map(([key]) => {
					const d = M.interval(col(tag, key).map((x, i) => x - col(REFERENCE, key)[i]));
					return `${signed(d.mean, 2)} [${d.lo.toFixed(2)}, ${d.hi.toFixed(2)}]${d.lo > 0 || d.hi < 0 ? "*" : " "}`;
				}),
			],
			W1b,
		),
	);
}

// ---------------------------------------------------------------------------
// 2. The reward for losing from every starting position
// ---------------------------------------------------------------------------

console.log("\n2. The reward for losing by starting position (n-th worst record among the 14 that missed the playoffs), draft places\n");
const W2 = [10, ...MECHS.map(() => 14)];
console.log(pad(["position", ...MECHS.map(([, , name]) => name.replace(" COLA", "").replace(" lottery", ""))], W2));
for (let i = 0; i < RANKS.length; i++) {
	console.log(pad([`${RANKS[i]}`, ...MECHS.map(([tag]) => signed(mean(leagues[tag].map((v) => meanOf(v.rewards[i]))), 2))], W2));
}
// How many seasons each cell of the 3-2-1 column averages: a team outside the
// 3-2-1 pool has no reward to measure.
const scored321 = RANKS.map((_, i) => leagues[REFERENCE].reduce((s, v) => s + v.rewards[i].filter((x) => x != null).length, 0));
console.log(`\nSeasons behind each 3-2-1 figure, of 750: ${RANKS.map((r, i) => `${r}:${scored321[i]}`).join("  ")}`);

// ---------------------------------------------------------------------------
// 3. The figures behind the text
// ---------------------------------------------------------------------------

console.log("\n3. The figures behind the text\n");

console.log("Starting positions in seasons with a positive reward for losing (13 positions in each of 750 seasons)\n");
for (const [tag, , name] of MECHS) {
	const all = leagues[tag].flatMap((v) => v.rewards.flat()).filter((x) => x != null);
	console.log(pad([name, `${all.filter((x) => x > ROUNDING).length} of ${all.length}`], [20, 16]));
}

console.log("\nLongest wait for a series win or a top-three pick: lowest and highest league\n");
for (const [tag, , name] of MECHS) {
	const v = col(tag, "L");
	console.log(pad([name, `${Math.min(...v)} to ${Math.max(...v)}`], [20, 12]));
}

console.log("\nWaits for a series win that ended, per league (average over the 30 leagues)\n");
for (const [tag, , name] of MECHS) console.log(pad([name, mean(col(tag, "ended")).toFixed(1)], [20, 8]));

console.log("\nTop-three picks that went to a team that lost in the first round\n");
for (const [tag, , name] of MECHS) {
	const picks = leagues[tag].reduce((s, v) => s + v.topThree, 0);
	const losers = leagues[tag].reduce((s, v) => s + v.topThreeToFirstRoundLosers, 0);
	console.log(pad([name, `${losers} of ${picks} (${((100 * losers) / picks).toFixed(1)}%)`], [20, 24]));
}
console.log("");
