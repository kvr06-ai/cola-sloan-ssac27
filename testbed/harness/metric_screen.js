#!/usr/bin/env node
/**
 * Screening pass over candidate "worst team" priority metrics.
 *
 * Testing a priority metric as a live mechanism means running the engine with
 * the draft order following that metric, which changes how the league evolves,
 * so every candidate costs its own full arm. Before spending that, most
 * candidates can be screened on league histories that already exist, because
 * three of the properties that decide whether a metric is usable do not require
 * the metric to be driving the draft.
 *
 *   discrimination   How many of the fourteen lottery teams does the metric
 *                    actually separate? A metric on which most teams are tied
 *                    cannot order a draft no matter how good its intent. Counted
 *                    as distinct values among the pool and as the share of pool
 *                    teams sharing their value with someone else.
 *   record coupling  Correlation with the season just played. This is NOT the
 *                    tanking test and should not be read as one: a metric can
 *                    correlate with record while being untouchable within a
 *                    season, which is exactly the case for every drought here.
 *                    It measures how much the metric merely proxies record, and
 *                    so how much of the equity case for it is already served by
 *                    the reverse-standings order a league runs anyway.
 *   movability       Whether a single season's within-season choices can move
 *                    the metric at all, which is the tanking-proof test.
 *
 * Histories are read from the NBA-rules arm, whose draft order never consults
 * any of these metrics, so the substrate is not shaped by the thing being
 * screened.
 *
 * Usage: node metric_screen.js [runsDir=runs]
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] ?? "runs";
const WINDOW = 15;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function corr(xs, ys) {
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		const a = xs[i] - mx;
		const b = ys[i] - my;
		sxy += a * b;
		sxx += a * a;
		syy += b * b;
	}
	return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

// playoffRoundsWon semantics in a four-round playoff:
//   -1 missed the playoffs · 0 lost round 1 · 1 won round 1 · 2 won round 2,
//   i.e. reached the conference finals · 3 won the conference finals, i.e.
//   reached the Finals · 4 champion.
const METRICS = [
	["drought: since winning a playoff series", (p) => p >= 1, "drought"],
	["drought: since reaching conference finals", (p) => p >= 2, "drought"],
	["drought: since reaching the Finals", (p) => p >= 3, "drought"],
	["drought: since winning a championship", (p) => p >= 4, "drought"],
	["count: championships to date", (p) => p >= 4, "count"],
	["count: conference finals reached", (p) => p >= 2, "count"],
	["count: playoff series won to date", null, "series"],
];

const reps = JSON.parse(fs.readFileSync(path.join(ROOT, "ref", "nba.json"), "utf8"));

console.log(`\n===== Screening candidate priority metrics on existing league histories =====\n`);
console.log(
	`Read from the NBA-rules arm (48 leagues x 15 seasons), whose draft order consults none of these,`,
);
console.log(`so nothing here is shaped by the metric being screened.\n`);
console.log(
	`metric                                      distinct values   teams tied   corr with`,
);
console.log(
	`                                            among the 14      with someone this season's record`,
);
console.log("-".repeat(104));

for (const [label, hits, kind] of METRICS) {
	const distinct = [];
	const tied = [];
	const cx = [];
	const cy = [];

	for (const rep of reps) {
		const log = rep.seasonLog;
		// running history per team
		const last = new Map(); // tid -> most recent season index satisfying the event
		const tally = new Map(); // tid -> running count
		for (let sIdx = 0; sIdx < log.length; sIdx++) {
			const e = log[sIdx];
			const pool = e.teams.filter((t) => t.playoffRoundsWon < 0);
			if (pool.length === 14 && sIdx >= 3) {
				const val = (t) => {
					if (kind === "drought") {
						const l = last.get(t.tid);
						return l === undefined ? sIdx + 1 : sIdx - l;
					}
					if (kind === "series") return tally.get(t.tid) ?? 0;
					return tally.get(t.tid) ?? 0;
				};
				const vals = pool.map(val);
				distinct.push(new Set(vals).size);
				const counts = {};
				for (const v of vals) counts[v] = (counts[v] ?? 0) + 1;
				tied.push(vals.filter((v) => counts[v] > 1).length / vals.length);
				for (let i = 0; i < pool.length; i++) {
					cx.push(vals[i]);
					cy.push(pool[i].wins);
				}
			}
			// advance the history with this season's outcomes
			for (const t of e.teams) {
				const p = t.playoffRoundsWon;
				if (kind === "series") {
					tally.set(t.tid, (tally.get(t.tid) ?? 0) + Math.max(0, p));
				} else if (hits && hits(p)) {
					last.set(t.tid, sIdx);
					tally.set(t.tid, (tally.get(t.tid) ?? 0) + 1);
				}
			}
		}
	}
	console.log(
		`${label.padEnd(44)} ${mean(distinct).toFixed(1).padStart(6)} of 14   ` +
			`${(100 * mean(tied)).toFixed(0).padStart(8)}%   ${corr(cx, cy).toFixed(3).padStart(10)}`,
	);
}

console.log(
	`\nA metric separating few of the fourteen cannot order a draft on its own, whatever its intent.`,
);
console.log(
	`Correlation with record is a separate question from manipulability. None of these metrics can be`,
);
console.log(
	`moved by a team already out of contention, since all of them update on playoff outcomes only; the`,
);
console.log(
	`manipulation they do admit is losing a playoff series, which Lemma 2 bounds. Neither column needs`,
);
console.log(`a new engine run.\n`);
