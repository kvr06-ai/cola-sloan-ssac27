#!/usr/bin/env node
/**
 * Does the simulated league look like the NBA? The current-lottery arm of the
 * 25-season run against the real league over its last 25 seasons.
 *
 * Real: data/nba-data.json (standings, playoff results and draft order,
 * 1999-00 to 2025-26, the dataset behind the published backtester at
 * kvr06-ai.github.io/cola-manipulation-bound; franchise lineage follows relocations, so the
 * 2002 Hornets move is New Orleans and the 2004 Bobcats are Charlotte). The
 * window is 2001-02 to 2025-26, 25 seasons, the run's horizon. A team that
 * enters mid-window (Charlotte, 2004-05) is counted from its first season.
 * Simulated: runs/frontier/nba.json, 30 leagues x 25 seasons under the 2019
 * NBA lottery; the mean and the 10th to 90th percentile across leagues.
 *
 * Measures, one league at a time:
 *   longest drought without a series win, any team; teams never winning one;
 *   the average team's longest such drought; the same three for playoff
 *   appearances (play-in losers miss the playoffs); the season-to-season
 *   correlation of win percentage (pooled team pairs); the spread of win
 *   percentage within a season (standard deviation, averaged over seasons).
 *
 * Usage: node sim_vs_real.js [simFile=runs/frontier/nba.json] [realFile=data/nba-data.json]
 */

"use strict";

const fs = require("fs");

const SIM = process.argv[2] ?? "runs/frontier/nba.json";
const REAL = process.argv[3] ?? "data/nba-data.json";
const FIRST = process.env.Y0 ?? "2001-02";
const LAST = process.env.Y1 ?? "2025-26";
const SIM_GAMES = 82;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];
function corr(xs, ys) {
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxy / Math.sqrt(sxx * syy);
}

// seasons: [{ teams: [{ id, winp, series, playoffs }] }] in order.
function measures(seasons) {
	const out = {};
	for (const [key, hit] of [
		["series", (t) => t.series],
		["playoff", (t) => t.playoffs],
	]) {
		const now = {};
		const best = {};
		const ever = {};
		for (const s of seasons) {
			for (const t of s.teams) {
				if (hit(t)) {
					now[t.id] = 0;
					ever[t.id] = true;
				} else now[t.id] = (now[t.id] ?? 0) + 1;
				best[t.id] = Math.max(best[t.id] ?? 0, now[t.id]);
			}
		}
		const runs = Object.values(best);
		out[`${key}Max`] = Math.max(...runs);
		out[`${key}Never`] = Object.keys(best).filter((id) => !ever[id]).length;
		out[`${key}Avg`] = mean(runs);
	}
	const xs = [];
	const ys = [];
	for (let i = 1; i < seasons.length; i++) {
		const prev = new Map(seasons[i - 1].teams.map((t) => [t.id, t.winp]));
		for (const t of seasons[i].teams) {
			if (prev.has(t.id)) {
				xs.push(prev.get(t.id));
				ys.push(t.winp);
			}
		}
	}
	out.lagCorr = corr(xs, ys);
	out.spread = mean(seasons.map((s) => sd(s.teams.map((t) => t.winp))));
	return out;
}

const real = JSON.parse(fs.readFileSync(REAL, "utf8")).seasons;
const i0 = real.findIndex((s) => s.season === FIRST);
const i1 = real.findIndex((s) => s.season === LAST);
const realSeasons = real.slice(i0, i1 + 1).map((s) => ({
	name: s.season,
	teams: s.teams.map((t) => ({
		id: t.id,
		winp: t.wins / (t.wins + t.losses),
		series: t.seriesWon >= 1,
		playoffs: t.madePlayoffs,
	})),
}));
const realM = measures(realSeasons);

const who = (hit) => {
	const now = {};
	const best = {};
	for (const s of realSeasons) {
		for (const t of s.teams) {
			now[t.id] = hit(t) ? 0 : (now[t.id] ?? 0) + 1;
			best[t.id] = Math.max(best[t.id] ?? 0, now[t.id]);
		}
	}
	const top = Math.max(...Object.values(best));
	return Object.keys(best).filter((id) => best[id] === top).join(", ");
};

const simM = JSON.parse(fs.readFileSync(SIM, "utf8")).map((rep) =>
	measures(
		rep.seasonLog.map((e) => ({
			teams: e.teams.map((t) => ({
				id: t.tid,
				winp: t.wins / SIM_GAMES,
				series: t.playoffRoundsWon >= 1,
				playoffs: t.playoffRoundsWon >= 0,
			})),
		})),
	),
);

// [key, label, decimals for real / simulated mean / percentiles, who holds the real max]
const ROWS = [
	["seriesMax", "Longest drought without a series win, any team", [0, 1, 0], who((t) => t.series)],
	["seriesNever", "Teams never winning a series", [0, 2, 0]],
	["seriesAvg", "Average team's longest drought without a series win", [1, 1, 1]],
	["playoffMax", "Longest playoff drought, any team", [0, 1, 0], who((t) => t.playoffs)],
	["playoffNever", "Teams never making the playoffs", [0, 0, 0]],
	["playoffAvg", "Average team's longest playoff drought", [1, 1, 1]],
	["lagCorr", "Win% correlation from one season to the next", [2, 2, 2]],
	["spread", "Spread of win% within a season (standard deviation)", [2, 2, 2]],
];
console.log(`\nReal NBA ${FIRST} to ${LAST} (${realSeasons.length} seasons) against ${simM.length} simulated leagues (${SIM})\n`);
console.log("measure".padEnd(56) + "real".padStart(26) + "   simulated mean (10th to 90th)");
for (const [key, name, [dr, dm, dq], names] of ROWS) {
	const v = simM.map((m) => m[key]);
	const r = realM[key].toFixed(dr) + (names ? ` (${names})` : "");
	console.log(
		name.padEnd(56) +
			r.padStart(26) +
			`   ${mean(v).toFixed(dm)} (${pct(v, 0.1).toFixed(dq)} to ${pct(v, 0.9).toFixed(dq)})`,
	);
}
