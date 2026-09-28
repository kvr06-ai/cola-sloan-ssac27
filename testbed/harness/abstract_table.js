#!/usr/bin/env node
/**
 * The SSAC27 abstract's table, one column per criterion, on the 25-season run.
 *
 * Reads runs/frontier/<tag>.json (30 leagues x 25 seasons per mechanism, shared
 * seeds) and prints, per mechanism, the league mean of:
 *   stuck      longest run of seasons any team spends with neither a playoff
 *              series win nor a top-3 pick (targeted help: the "hope" measure)
 *   stuckAvg   the same run averaged over teams
 *   maxSeries  longest drought between playoff-series wins, any team (parity,
 *              the criterion as pre-specified)
 *   never      teams never winning a series in 25 seasons
 *   avgPlayoff the average team's longest run without a playoff appearance
 *   maxPlayoff the longest run without a playoff appearance, any team
 * then the paired difference of each mechanism against the 2019 NBA lottery and
 * the adopted 3-2-1, with a 95% t interval over the 30 leagues.
 *
 * For "simplerule" (Simple COLA as the abstract words it) it also prices the
 * reward for losing exactly: take each season as it happened, drop one pool
 * team to the worst record in the pool, and re-rank under the rule (drought,
 * then most wins, then a coin flip, so tied positions count at their mean).
 * Positive = losing buys an earlier pick. The record-based and index mechanisms
 * are priced by tank_counterfactual.js.
 *
 * Usage: node abstract_table.js [runsDir=runs/frontier]
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] ?? "runs/frontier";
const MECHS = [
	["nba", "Current NBA lottery (2019 to 2026)"],
	["t321", "New NBA lottery, 3-2-1 (from 2027)"],
	["uniform", "Equal-odds lottery"],
	["classic", "Classic COLA"],
	["waitlist", "Waitlist COLA"],
	["simple", "Simple COLA, as first run (index)"],
	["simplerule", "Simple COLA, abstract rule"],
	["full", "Full-lottery COLA"],
	["countdown", "Countdown COLA"],
	["beckett", "Beckett COLA"],
];
const BASES = ["nba", "t321"];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const T29 = 2.045; // t_{0.975}, df 29

// Longest run of consecutive seasons in which stop(t) is false, per team.
function longestRuns(seasonLog, stop) {
	const now = {};
	const best = {};
	for (const e of seasonLog) {
		for (const t of e.teams) {
			if (stop(t)) now[t.tid] = 0;
			else now[t.tid] = (now[t.tid] ?? 0) + 1;
			best[t.tid] = Math.max(best[t.tid] ?? 0, now[t.tid]);
		}
	}
	return Object.values(best);
}

function perLeague(seasonLog) {
	const stuck = longestRuns(seasonLog, (t) => t.playoffRoundsWon >= 1 || (t.draftPick ?? 99) <= 3);
	const series = longestRuns(seasonLog, (t) => t.playoffRoundsWon >= 1);
	const playoff = longestRuns(seasonLog, (t) => t.playoffRoundsWon >= 0);
	return {
		stuck: Math.max(...stuck),
		stuckAvg: mean(stuck),
		maxSeries: Math.max(...series),
		never: series.filter((r) => r === seasonLog.length).length,
		avgPlayoff: mean(playoff),
		maxPlayoff: Math.max(...playoff),
	};
}

// Exact reward for losing under the simple rule, by starting rank among the 14
// non-playoff teams (rank 1 = worst record), dropping to the worst record.
function simpleRuleReward(seasonLog) {
	const drought = {};
	const byRank = {};
	for (const e of seasonLog) {
		for (const t of e.teams) {
			drought[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (drought[t.tid] ?? 0) + 1;
		}
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 1);
		const pick = (tid, wins) => {
			const me = { d: drought[tid], w: wins };
			let ahead = 0;
			let tied = 0;
			for (const o of pool) {
				if (o.tid === tid) continue;
				const d = drought[o.tid];
				if (d > me.d || (d === me.d && o.wins > me.w)) ahead++;
				else if (d === me.d && o.wins === me.w) tied++;
			}
			return 1 + ahead + tied / 2;
		};
		const lottery = e.teams.filter((t) => t.playoffRoundsWon < 0).sort((a, b) => a.wins - b.wins);
		if (lottery.length === 14) {
			const worst = lottery[0].wins;
			for (let r = 2; r <= 14; r++) {
				const t = lottery[r - 1];
				(byRank[r] ??= []).push(pick(t.tid, t.wins) - pick(t.tid, worst - 1));
			}
		}
		for (const t of e.teams) if ((t.draftPick ?? 99) <= 3) drought[t.tid] = 0;
	}
	return byRank;
}

const data = {};
const logs = {};
for (const [tag] of MECHS) {
	const file = path.join(ROOT, `${tag}.json`);
	if (!fs.existsSync(file)) {
		console.error(`skip ${tag}: ${file} not found`);
		continue;
	}
	const reps = JSON.parse(fs.readFileSync(file, "utf8"));
	data[tag] = new Map(reps.map((r) => [r.seed, perLeague(r.seasonLog)]));
	logs[tag] = reps;
}
const tags = MECHS.map(([t]) => t).filter((t) => data[t]);
const KEYS = ["stuck", "stuckAvg", "maxSeries", "never", "avgPlayoff", "maxPlayoff"];
const label = Object.fromEntries(MECHS);

console.log("\nLeague means over the 30 leagues (seasons unless noted; never = teams per league)\n");
console.log("mechanism".padEnd(38) + KEYS.map((k) => k.padStart(11)).join(""));
for (const tag of tags) {
	const v = [...data[tag].values()];
	console.log(label[tag].padEnd(38) + KEYS.map((k) => mean(v.map((x) => x[k])).toFixed(2).padStart(11)).join(""));
}

for (const base of BASES.filter((b) => data[b])) {
	console.log(`\nPaired difference vs ${label[base]}: mean [95% CI], negative = shorter / fewer\n`);
	console.log("mechanism".padEnd(38) + KEYS.map((k) => k.padStart(22)).join(""));
	for (const tag of tags) {
		if (tag === base) continue;
		const cells = KEYS.map((k) => {
			const d = [...data[tag].keys()].filter((s) => data[base].has(s)).map((s) => data[tag].get(s)[k] - data[base].get(s)[k]);
			const m = mean(d);
			const h = (T29 * sd(d)) / Math.sqrt(d.length);
			return `${m.toFixed(2)} [${(m - h).toFixed(2)}, ${(m + h).toFixed(2)}]`.padStart(22);
		});
		console.log(label[tag].padEnd(38) + cells.join(""));
	}
}

if (logs.simplerule) {
	const all = {};
	for (const rep of logs.simplerule) {
		const r = simpleRuleReward(rep.seasonLog);
		for (const [k, v] of Object.entries(r)) (all[k] ??= []).push(...v);
	}
	console.log("\nSimple rule: draft places gained by dropping to the worst record, by starting rank (1 = worst)\n");
	console.log(Object.keys(all).map((k) => `${k}:${mean(all[k]).toFixed(2)}`).join("  "));
	const h = all[5];
	console.log(`5th-worst to last: mean ${mean(h).toFixed(3)}, max ${Math.max(...h).toFixed(2)}, share > 0: ${(h.filter((x) => x > 0).length / h.length).toFixed(3)} (n=${h.length} seasons)`);
}
