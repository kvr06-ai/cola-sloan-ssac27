#!/usr/bin/env node
/**
 * Section 6's numbers: the run's design, the simulated leagues against the
 * NBA, and the two help measures on real NBA standings.
 *
 * Reads the nine run files in runs/frontier (30 leagues x 25 seasons each) and
 * data/nba-data.json (NBA standings, playoff results and first-round picks,
 * 1999-00 to 2025-26; the seasons to 2024-25 were compiled from Basketball
 * Reference and 2025-26 from ESPN, and each team's pick is the best first-round
 * pick it held on lottery day). The 2025-26 records and first-round winners
 * match Basketball Reference as read on 2026-11-13. Franchises keep one id
 * through relocations, and Charlotte is counted from its first season, 2004-05.
 * The file gives every team of a season the same number of games, so 2019-20,
 * when teams played unequal numbers of games, is ranked by wins.
 *
 * 1. The runs. Leagues, seasons, teams and games per mechanism; the first
 *    season in which two mechanisms' versions of a league differ; and, across
 *    the 30 leagues, how closely a league's result under one mechanism tracks
 *    its result under another.
 * 2. The old-lottery leagues against the NBA's last 25 seasons, 2001-02 to
 *    2025-26, the run's own length. One value for the NBA; the mean, lowest
 *    and highest of the 30 simulated leagues; and how many of them fall below
 *    the NBA's value.
 * 3. The two help measures (measures.js) on real standings, one season at a
 *    time. Each of the 22 seasons from 2004-05, the first with 30 teams, is
 *    scored on its own final standings, with every team's wait and earlier
 *    picks taken from the real seasons since 1999-00. No season is replayed.
 *    The old lottery's 2019 odds are applied to every season. Beside each
 *    real-standings mean and its 95% interval over the 22 seasons are the
 *    simulated values over all 25 seasons of each league and over seasons 6 to
 *    25, which have the same five seasons of history behind them as 2004-05
 *    has in the data.
 *
 * Nothing here is sampled, so the output is identical on every run.
 *
 * Usage: node design_check.js [runsDir=runs/frontier] [realFile=data/nba-data.json]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const M = require("./measures.js");

const ROOT = process.argv[2] ?? "runs/frontier";
const REAL = process.argv[3] ?? "data/nba-data.json";

const MECHS = [
	["nba", "Old lottery"],
	["uniform", "Equal-odds lottery"],
	["t321", "3-2-1"],
	["classic", "Classic COLA"],
	["waitlist", "Waitlist COLA"],
	["full", "Full-lottery COLA"],
	["simplerule", "Simple COLA"],
	["countdown", "Countdown COLA"],
	["beckett", "Beckett COLA"],
];
// The NBA window for part 2 is the run's own length, 25 seasons.
const NBA_FIRST = "2001-02";
// Part 3 skips each league's first five seasons in its second simulated
// column: the real seasons scored start five seasons into the data.
const START_UP_SEASONS = 5;

const { mean, sd } = M;
const runs = Object.fromEntries(
	MECHS.map(([tag]) => [
		tag,
		JSON.parse(fs.readFileSync(path.join(ROOT, `${tag}.json`), "utf8")).sort((a, b) => a.seed - b.seed),
	]),
);
const realAll = M.fromReal(JSON.parse(fs.readFileSync(REAL, "utf8")));

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
const pad = (cells, widths) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[0]) : String(c).padStart(widths[i]))).join("");

// ---------------------------------------------------------------------------
// 1. The runs
// ---------------------------------------------------------------------------

console.log(`\nSection 6, ${ROOT} and ${REAL}\n`);
console.log("1. The runs\n");
const W1 = [20, 9, 10, 8, 16, 18, 16];
console.log(pad(["mechanism", "leagues", "seasons", "teams", "missed playoffs", "lost first round", "won a series"], W1));
let seasonsTotal = 0;
let gamesTotal = 0;
for (const [tag, name] of MECHS) {
	const reps = runs[tag];
	// Every distinct value a count takes over the run; one value means it never varies.
	const count = (f) => [...new Set(reps.flatMap((r) => r.seasonLog.map(f)))].join("/");
	console.log(
		pad(
			[
				name,
				reps.length,
				[...new Set(reps.map((r) => r.seasonLog.length))].join("/"),
				count((e) => e.teams.length),
				count((e) => e.teams.filter((t) => t.playoffRoundsWon < 0).length),
				count((e) => e.teams.filter((t) => t.playoffRoundsWon === 0).length),
				count((e) => e.teams.filter((t) => t.playoffRoundsWon >= 1).length),
			],
			W1,
		),
	);
	for (const r of reps) {
		seasonsTotal += r.seasonLog.length;
		// Each game has one winner, so a season's wins count its games.
		for (const e of r.seasonLog) gamesTotal += e.teams.reduce((s, t) => s + t.wins, 0);
	}
}
console.log(`\nSeasons in all: ${seasonsTotal}. Regular-season games in all: ${gamesTotal}.`);
const seedSets = new Set(MECHS.map(([tag]) => runs[tag].map((r) => r.seed).join(",")));
console.log(`Every mechanism runs seeds ${runs.nba[0].seed} to ${runs.nba.at(-1).seed}: ${seedSets.size === 1 ? "yes" : "NO"}.`);

// Standings and playoff results of one season, as one string.
const played = (e) =>
	e.teams
		.slice()
		.sort((a, b) => a.tid - b.tid)
		.map((t) => `${t.tid}:${t.wins}:${t.playoffRoundsWon}`)
		.join("|");
// For each league and each pair of mechanisms, the first season in which the
// two versions of the league differ. Season 1 is played before any draft.
{
	const firstDiffers = {};
	let pairs = 0;
	for (let k = 0; k < runs.nba.length; k++) {
		for (let i = 0; i < MECHS.length; i++) {
			for (let j = i + 1; j < MECHS.length; j++) {
				const a = runs[MECHS[i][0]][k].seasonLog;
				const b = runs[MECHS[j][0]][k].seasonLog;
				let s = 0;
				while (s < a.length && played(a[s]) === played(b[s])) s++;
				firstDiffers[s + 1] = (firstDiffers[s + 1] ?? 0) + 1;
				pairs++;
			}
		}
	}
	console.log(
		`First season in which two mechanisms' versions of a league differ, over ${pairs} pairs (36 pairs of mechanisms x 30 leagues): ` +
			Object.entries(firstDiffers)
				.map(([s, n]) => `season ${s} in ${n}`)
				.join(", ") +
			".",
	);
}

// One number per league for each wait measure, under each mechanism.
const waits = {};
for (const [tag] of MECHS) {
	waits[tag] = runs[tag].map((rep) => {
		const league = M.fromSim(rep);
		return {
			longest: M.longestWait(league),
			win: mean(M.waitLengths(league, (t) => t.wonSeries)),
			back: mean(M.waitLengths(league, (t) => !t.missed)),
		};
	});
}
console.log("\nAcross the 30 leagues, correlation of a measure between two mechanisms (36 pairs of mechanisms)\n");
for (const [key, name] of [
	["longest", "Longest wait for a series win or top-three pick"],
	["win", "Wait for the next series win"],
	["back", "Wait to return to the playoffs"],
]) {
	const cs = [];
	for (let i = 0; i < MECHS.length; i++) {
		for (let j = i + 1; j < MECHS.length; j++) {
			cs.push(corr(waits[MECHS[i][0]].map((v) => v[key]), waits[MECHS[j][0]].map((v) => v[key])));
		}
	}
	console.log(`${name.padEnd(50)} mean ${mean(cs).toFixed(2)}, lowest ${Math.min(...cs).toFixed(2)}, highest ${Math.max(...cs).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 2. The old-lottery leagues against the NBA
// ---------------------------------------------------------------------------

// Correlation of a team's share of games won with its own share `lag` seasons
// earlier, over every team and season of the league.
function persistence(league, lag) {
	const xs = [];
	const ys = [];
	for (let i = lag; i < league.length; i++) {
		const before = new Map(league[i - lag].teams.map((t) => [t.id, t.rec]));
		for (const t of league[i].teams) {
			if (before.has(t.id)) {
				xs.push(before.get(t.id));
				ys.push(t.rec);
			}
		}
	}
	return corr(xs, ys);
}
// Share of playoff teams that made the playoffs again the next season.
function playoffReturn(league) {
	let again = 0;
	let all = 0;
	for (let i = 1; i < league.length; i++) {
		const before = new Map(league[i - 1].teams.map((t) => [t.id, t]));
		for (const t of league[i].teams) {
			const b = before.get(t.id);
			if (b && !b.missed) {
				all++;
				if (!t.missed) again++;
			}
		}
	}
	return again / all;
}
function profile(league) {
	return {
		spread: mean(league.map((s) => sd(s.teams.map((t) => t.rec)))),
		lag1: persistence(league, 1),
		lag3: persistence(league, 3),
		again: playoffReturn(league),
		back: mean(M.waitLengths(league, (t) => !t.missed)),
		win: mean(M.waitLengths(league, (t) => t.wonSeries)),
		ended: M.waitLengths(league, (t) => t.wonSeries).length,
		longest: M.longestWait(league),
	};
}

const nba = realAll.slice(realAll.findIndex((s) => s.label === NBA_FIRST));
const nbaProfile = profile(nba);
const simProfiles = runs.nba.map((rep) => profile(M.fromSim(rep)));
// The team or teams that hold the NBA's longest wait, with its first and last season.
const holders = (() => {
	const now = {};
	const out = [];
	nba.forEach((s, i) => {
		for (const t of s.teams) {
			now[t.id] = t.wonSeries || (t.pick ?? 99) <= 3 ? 0 : (now[t.id] ?? 0) + 1;
			if (now[t.id] === nbaProfile.longest) out.push(`${t.id}, ${nba[i - now[t.id] + 1].label} to ${s.label}`);
		}
	});
	return out.join("; ");
})();

console.log(`\n2. The old-lottery leagues against the NBA, ${nba[0].label} to ${nba.at(-1).label} (${nba.length} seasons)\n`);
const W2 = [62, 10, 11, 10, 10, 12];
console.log(pad(["measure", "NBA", "sim mean", "lowest", "highest", "below NBA"], W2));
for (const [key, name, d] of [
	["spread", "Spread of win share within a season (standard deviation)", 3],
	["lag1", "Correlation of win share, one season apart", 2],
	["lag3", "Correlation of win share, three seasons apart", 2],
	["again", "Playoff teams back in the playoffs a season later (share)", 3],
	["back", "Wait to return to the playoffs (seasons)", 2],
	["win", "Wait for the next series win (seasons)", 2],
	["ended", "Waits for a series win that ended (count)", 1],
	["longest", "Longest wait for a series win or top-three pick (seasons)", 1],
]) {
	const v = simProfiles.map((p) => p[key]);
	console.log(
		pad(
			[name, nbaProfile[key].toFixed(d), mean(v).toFixed(d), Math.min(...v).toFixed(d), Math.max(...v).toFixed(d), `${v.filter((x) => x < nbaProfile[key]).length} of ${v.length}`],
			W2,
		),
	);
}
console.log(`\nThe NBA's longest wait is held by: ${holders}.`);

// ---------------------------------------------------------------------------
// 3. The two help measures on real standings
// ---------------------------------------------------------------------------

const ROWS = [
	["Help for a worse record, old lottery", "nba", (s, st) => M.rewardForLosing("old", s, st)],
	["Help for a worse record, 3-2-1", "t321", (s, st) => M.rewardForLosing("t321", s, st)],
	["Help for a worse record, Simple COLA", "simplerule", (s, st) => M.rewardForLosing("simple", s, st)],
	["Help for a longer wait, Simple COLA", "simplerule", (s, st) => M.helpForWaiting("simple", s, st)],
];

// One value per season of a league; null where the season is not scored.
function bySeason(league, fn) {
	const out = [];
	M.walk(league, (season, state) => out.push(fn(season, state)));
	return out;
}
const scored = realAll.filter((s) => s.teams.filter((t) => t.missed).length === 14);
console.log(`\n3. The two help measures on real standings, ${scored[0].label} to ${scored.at(-1).label} (${scored.length} seasons), draft places\n`);
const W3 = [40, 28, 20, 18, 24];
console.log(pad(["measure and mechanism", "real mean [95% interval]", "real seasons > 0", "sim, 25 seasons", "sim, seasons 6 to 25"], W3));
for (const [name, tag, fn] of ROWS) {
	const values = bySeason(realAll, fn).filter((v) => v != null);
	const real = M.interval(values);
	const sim = runs[tag].map((rep) => bySeason(M.fromSim(rep), fn));
	const all = mean(sim.map((v) => mean(v.filter((x) => x != null))));
	const late = mean(sim.map((v) => mean(v.slice(START_UP_SEASONS).filter((x) => x != null))));
	const inside = (x) => (x >= real.lo && x <= real.hi ? "" : " OUTSIDE");
	console.log(
		pad(
			[
				name,
				`${real.mean.toFixed(2)} [${real.lo.toFixed(2)}, ${real.hi.toFixed(2)}]`,
				`${values.filter((v) => v > 0).length} of ${values.length}`,
				all.toFixed(2) + inside(all),
				late.toFixed(2) + inside(late),
			],
			W3,
		),
	);
}
console.log("");
