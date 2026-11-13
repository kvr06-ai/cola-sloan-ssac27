/**
 * The paper's measures, written once, so that a table computes them the same
 * way on a simulated league and on real NBA seasons.
 *
 * A league is a list of seasons in order. A season is { label, teams }, and a
 * team is
 *   id         the same id in every season of the league
 *   conf       "E" or "W"
 *   rec        share of its games won this season
 *   missed     true if it missed the playoffs (a play-in loser missed them)
 *   wonSeries  true if it won at least one playoff series
 *   pick       its first-round pick in the draft that followed, or null
 * fromSim() builds a league from one replicate of a run file, and fromReal()
 * builds one from data/nba-data.json.
 *
 * Measures
 *   waitLengths(league, hit)   length of every completed run of seasons a team
 *                              spends without `hit`. With hit = made the
 *                              playoffs it is the wait to return to the
 *                              playoffs; with hit = won a series it is the wait
 *                              for the next series win. A run still open when
 *                              the league ends is left out.
 *   longestWait(league)        the longest run of seasons any team spends with
 *                              neither a playoff series win nor a top-three pick.
 *   rewardForLosing(mech, ...) draft places a team gains when its record alone
 *                              drops to the worst in the league. The team is
 *                              the one with the `rank`-th worst record among
 *                              the 14 that missed the playoffs. A positive
 *                              value is an earlier pick.
 *   helpForWaiting(mech, ...)  draft places a team gains when its wait alone
 *                              rises to one season above the longest wait in
 *                              the pool. The team is the one with the `rank`-th
 *                              longest wait among the 14 that missed the
 *                              playoffs.
 * Both help measures are expectations over the mechanism's drawing, computed
 * exactly: pick_dist.js enumerates the old lottery's four drawn picks, and
 * t321Picks() below sums over every state of the 3-2-1 drawing. Mechanisms
 * here: "old" (the 2019 to 2026 lottery), "t321" (3-2-1 as adopted) and
 * "simple" (Simple COLA).
 *
 * Carry-over state comes from the league's own history, walked in order by
 * walk(): each team's wait under Simple COLA (seasons since it last won a
 * playoff series or received a top-three pick) and its picks in earlier
 * drafts, which 3-2-1's limits on repeat picks read.
 */

"use strict";

const { pickDistribution, buildPool } = require("./pick_dist.js");

// The simulator plays an 82-game season (zengm-fork defaultGameAttributes.ts,
// numGames).
const SIM_GAMES = 82;

// NBA conferences, unchanged since 2004-05, when New Orleans moved to the West
// and Charlotte joined the East. Every season scored on real standings is
// 2004-05 or later, so this is each season's own alignment.
const EAST = ["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL", "NYK", "ORL", "PHI", "TOR", "WAS"];

// Chances per team in the 3-2-1 drawing as adopted (Table 1 of the paper): the
// three worst records 2, the other seven teams that miss the play-in 3, the
// ninth and tenth seeds 2, the losers of the seven-eight games 1.
const T321_CHANCES = { bottom3: 2, nonPlayIn: 3, seed910: 2, seed8: 1 };

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

function fromSim(rep) {
	return rep.seasonLog.map((e, i) => ({
		label: String(i + 1),
		teams: e.teams.map((t) => ({
			id: t.tid,
			conf: t.conf,
			rec: t.wins / SIM_GAMES,
			missed: t.playoffRoundsWon < 0,
			wonSeries: t.playoffRoundsWon >= 1,
			pick: t.draftPick ?? null,
		})),
	}));
}

function fromReal(data) {
	return data.seasons.map((s) => ({
		label: s.season,
		teams: s.teams.map((t) => ({
			id: t.id,
			conf: EAST.includes(t.id) ? "E" : "W",
			rec: t.wins / (t.wins + t.losses),
			missed: !t.madePlayoffs,
			wonSeries: t.seriesWon >= 1,
			pick: t.draftPick ?? null,
		})),
	}));
}

// Calls fn(season, state, index) for each season in order. state.wait holds
// each team's wait after that season's playoffs, and state.past its picks in
// the drafts before that season's draft, oldest first.
function walk(league, fn) {
	const wait = {};
	const past = {};
	league.forEach((season, index) => {
		for (const t of season.teams) wait[t.id] = t.wonSeries ? 0 : (wait[t.id] ?? 0) + 1;
		fn(season, { wait, past }, index);
		for (const t of season.teams) {
			if ((t.pick ?? 99) <= 3) wait[t.id] = 0;
			(past[t.id] ??= []).push(t.pick);
		}
	});
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

function waitLengths(league, hit) {
	const now = {};
	const done = [];
	for (const season of league) {
		for (const t of season.teams) {
			if (hit(t)) {
				if (now[t.id] > 0) done.push(now[t.id]);
				now[t.id] = 0;
			} else now[t.id] = (now[t.id] ?? 0) + 1;
		}
	}
	return done;
}

function longestWait(league) {
	const now = {};
	let longest = 0;
	for (const season of league) {
		for (const t of season.teams) {
			now[t.id] = t.wonSeries || (t.pick ?? 99) <= 3 ? 0 : (now[t.id] ?? 0) + 1;
			longest = Math.max(longest, now[t.id]);
		}
	}
	return longest;
}

// ---------------------------------------------------------------------------
// The 3-2-1 drawing, exactly
// ---------------------------------------------------------------------------

const BITS = new Uint8Array(1 << 16);
for (let m = 1; m < BITS.length; m++) BITS[m] = BITS[m >> 1] + (m & 1);

// Expected pick of every team in the 3-2-1 pool. The pool is the eight worst
// records in each conference: five that miss the play-in, the ninth and tenth
// seeds, and the eighth-best record, which stands in for the loser of the
// seven-eight game as it does in the simulator's driver. All 16 picks are
// drawn, each among the teams still left and in proportion to their chances,
// under the adopted limits: no first pick in consecutive seasons, no third
// straight top-five pick, and the three worst records placed by pick 12. A
// limit that would leave no team to draw is skipped, as in the driver.
//
// The teams still left are one of 2^16 sets, and the pick number follows from
// the size of the set, so one pass over the sets gives each set's probability
// and each team's expected pick with no sampling.
function t321Picks(teams, past) {
	const byConf = {};
	for (const t of teams) (byConf[t.conf] ??= []).push(t);
	const role = new Map();
	const pool = [];
	for (const conf of Object.values(byConf)) {
		const worst8 = conf.slice().sort((a, b) => a.rec - b.rec).slice(0, 8);
		worst8.forEach((t, i) => role.set(t.id, i < 5 ? "nonPlayIn" : i < 7 ? "seed910" : "seed8"));
		pool.push(...worst8);
	}
	pool
		.filter((t) => role.get(t.id) === "nonPlayIn")
		.sort((a, b) => a.rec - b.rec)
		.slice(0, 3)
		.forEach((t) => role.set(t.id, "bottom3"));

	const n = pool.length;
	const back = (id, k) => {
		const h = past[id] ?? [];
		return h.length >= k ? h[h.length - k] : null;
	};
	const chances = pool.map((t) => T321_CHANCES[role.get(t.id)]);
	let bottom3 = 0;
	let hadFirst = 0;
	let hadTwoTopFive = 0;
	pool.forEach((t, i) => {
		if (role.get(t.id) === "bottom3") bottom3 |= 1 << i;
		if (back(t.id, 1) === 1) hadFirst |= 1 << i;
		if ((back(t.id, 1) ?? 99) <= 5 && (back(t.id, 2) ?? 99) <= 5) hadTwoTopFive |= 1 << i;
	});

	const prob = new Float64Array(1 << n);
	const expected = new Float64Array(n);
	prob[(1 << n) - 1] = 1;
	for (let left = (1 << n) - 1; left > 0; left--) {
		const p = prob[left];
		if (p === 0) continue;
		const pick = n - BITS[left] + 1;
		let cands = left;
		if (pick === 1 && cands & ~hadFirst) cands &= ~hadFirst;
		if (pick <= 5 && cands & ~hadTwoTopFive) cands &= ~hadTwoTopFive;
		if (pick <= 12) {
			const b3 = cands & bottom3;
			if (b3 && BITS[b3] >= 13 - pick) cands = b3;
		}
		let total = 0;
		for (let i = 0; i < n; i++) if (cands & (1 << i)) total += chances[i];
		for (let i = 0; i < n; i++) {
			if (!(cands & (1 << i))) continue;
			const q = (p * chances[i]) / total;
			expected[i] += q * pick;
			prob[left ^ (1 << i)] += q;
		}
	}
	return new Map(pool.map((t, i) => [t.id, expected[i]]));
}

// ---------------------------------------------------------------------------
// Expected pick of one team under each mechanism
// ---------------------------------------------------------------------------

// Simple COLA: place in the pool of teams without a series win, by longest
// wait and then by better record. A tie on both is settled by a coin flip, so
// it counts as half a place.
function simplePlace(teams, wait, id, myWait, myRec) {
	let ahead = 0;
	let tied = 0;
	for (const o of teams) {
		if (o.id === id || o.wonSeries) continue;
		if (wait[o.id] > myWait || (wait[o.id] === myWait && o.rec > myRec)) ahead++;
		else if (wait[o.id] === myWait && o.rec === myRec) tied++;
	}
	return 1 + ahead + tied / 2;
}

// Expected pick of team `id` this season, or null if it is outside the
// mechanism's pool.
function expectedPick(mech, teams, state, id) {
	if (mech === "old") {
		const pool = teams.filter((t) => t.missed).map((t) => ({ tid: t.id, wins: t.rec }));
		return pickDistribution(buildPool(pool, "nba"), 4).ePick[id] ?? null;
	}
	if (mech === "t321") return t321Picks(teams, state.past).get(id) ?? null;
	if (mech === "simple") {
		const me = teams.find((t) => t.id === id);
		return me.wonSeries ? null : simplePlace(teams, state.wait, id, state.wait[id], me.rec);
	}
	throw new Error(`unknown mechanism ${mech}`);
}

// ---------------------------------------------------------------------------
// The two help measures, one season at a time
// ---------------------------------------------------------------------------

// The 14 teams that missed the playoffs, worst record first; null when the
// season has another number of them (the NBA before 2004-05 had 29 teams).
function missedByRecord(teams) {
	const missed = teams.filter((t) => t.missed).sort((a, b) => a.rec - b.rec);
	return missed.length === 14 ? missed : null;
}

function rewardForLosing(mech, season, state, rank = 5) {
	const missed = missedByRecord(season.teams);
	if (!missed) return null;
	const team = missed[rank - 1];
	// Any record below the league's worst gives the same order; one game of an
	// 82-game season is the step abstract_table.js uses.
	const worse = missed[0].rec - 1 / SIM_GAMES;
	const moved = season.teams.map((t) => (t.id === team.id ? { ...t, rec: worse } : t));
	const before = expectedPick(mech, season.teams, state, team.id);
	const after = expectedPick(mech, moved, state, team.id);
	return before == null || after == null ? null : before - after;
}

function helpForWaiting(mech, season, state, rank = 5) {
	if (mech !== "simple") throw new Error(`helpForWaiting: ${mech} is not written yet`);
	const missed = missedByRecord(season.teams);
	if (!missed) return null;
	const { wait } = state;
	const team = missed.slice().sort((a, b) => wait[b.id] - wait[a.id] || b.rec - a.rec)[rank - 1];
	const longest = Math.max(...season.teams.filter((t) => !t.wonSeries).map((t) => wait[t.id]));
	return (
		simplePlace(season.teams, wait, team.id, wait[team.id], team.rec) -
		simplePlace(season.teams, wait, team.id, longest + 1, team.rec)
	);
}

// ---------------------------------------------------------------------------
// Small statistics
// ---------------------------------------------------------------------------

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
// Two-sided 95% point of Student's t, for the two sample sizes the paper uses:
// 29 degrees of freedom (30 leagues) and 21 (22 real seasons).
const T975 = { 29: 2.045, 21: 2.08 };
function interval(a) {
	const t = T975[a.length - 1];
	if (t == null) throw new Error(`no t value for n = ${a.length}`);
	const m = mean(a);
	const half = (t * sd(a)) / Math.sqrt(a.length);
	return { mean: m, lo: m - half, hi: m + half, n: a.length };
}

module.exports = {
	SIM_GAMES,
	fromSim,
	fromReal,
	walk,
	waitLengths,
	longestWait,
	t321Picks,
	expectedPick,
	rewardForLosing,
	helpForWaiting,
	mean,
	sd,
	interval,
};
