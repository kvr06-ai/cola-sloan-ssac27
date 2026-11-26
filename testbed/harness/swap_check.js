#!/usr/bin/env node
/**
 * Section 4.2's numbers: what a team gains and loses under Simple COLA by
 * losing one game on purpose to a rival that has waited longer.
 *
 * Reads runs/frontier/simplerule.json (30 leagues x 25 seasons) and follows
 * each team's wait as simple_losing_check.js does. In each season, take every
 * pool team A that missed the playoffs and every pool rival B with a longer
 * wait. A loses one game it won to B, so A finishes with one win fewer and B
 * with one more. Everything else is held as it happened.
 *
 * Two things can change.
 * 1. The tie-break. A can fall behind teams with the same wait, because it has
 *    one win fewer. This is exact. A tie on both wait and wins counts at its
 *    mean place, half a place per tied team.
 * 2. The playoffs. B leaves the pool only by winning a playoff series, and the
 *    extra win matters only if it changes a seed. In each conference, the teams
 *    are grouped by wins, best first, down to the group that reaches the tenth
 *    seed (seeds 1 to 6 reach the playoffs directly and seeds 7 to 10 play in,
 *    the simulator's NBA format). If those groups are the same after the swap,
 *    no seed can change and no rival leaves the pool. Otherwise B's chance of an
 *    added series win is estimated from the share of teams at each conference
 *    rank that won a series in these runs. The estimate is an upper one: the
 *    shares mix a team's seed with its strength, and one added win changes a
 *    team's seed but not its strength.
 *
 * Limits. The runs record season totals, not who won each game, so every pair
 * counts whether or not A beat B. The rest of the season is held as it
 * happened, and a changed bracket's effect on other teams' series is not
 * estimated.
 *
 * Usage: node swap_check.js [file=runs/frontier/simplerule.json]
 */

"use strict";

const fs = require("fs");

const FILE = process.argv[2] ?? "runs/frontier/simplerule.json";
// Seeds 1 to 6 reach the playoffs directly and seeds 7 to 10 play in (the
// simulator's NBA format, 15 teams and 8 playoff teams in each conference).
const TOP_SIX = 6;
const PLAY_IN_LAST = 10;

const reps = JSON.parse(fs.readFileSync(FILE, "utf8"));
const pct = (x) => `${(100 * x).toFixed(1)}%`;

// A's place in the pool by wait and then wins; a tie on both at its mean place.
function place(pool, me, winsOf) {
	let ahead = 0;
	let tied = 0;
	for (const o of pool) {
		if (o.tid === me.tid) continue;
		const ow = winsOf(o);
		const mw = winsOf(me);
		if (o.wait > me.wait || (o.wait === me.wait && ow > mw)) ahead++;
		else if (o.wait === me.wait && ow === mw) tied++;
	}
	return 1 + ahead + tied / 2;
}

// A conference's groups of teams with equal wins, best first, down to the group
// that reaches the tenth seed. No seed can change unless these groups do.
function seedGroups(teams, winsOf) {
	const byWins = {};
	for (const t of teams) (byWins[winsOf(t)] ??= []).push(t.tid);
	const out = [];
	let n = 0;
	for (const w of Object.keys(byWins).map(Number).sort((a, b) => b - a)) {
		out.push(byWins[w].slice().sort((a, b) => a - b).join(","));
		n += byWins[w].length;
		if (n >= PLAY_IN_LAST) break;
	}
	return out.join("|");
}

// A team's rank in its conference by wins; a tie at its mean rank.
function rank(teams, tid, winsOf) {
	const w = winsOf(teams.find((t) => t.tid === tid));
	const above = teams.filter((t) => winsOf(t) > w).length;
	const same = teams.filter((t) => winsOf(t) === w).length;
	return above + (same + 1) / 2;
}

// The share of teams at each conference rank that won a playoff series.
const byRank = {};
for (const rep of reps) {
	for (const e of rep.seasonLog) {
		for (const conf of ["E", "W"]) {
			const teams = e.teams.filter((t) => t.conf === conf);
			for (const t of teams) {
				const k = Math.round(rank(teams, t.tid, (x) => x.wins));
				byRank[k] ??= { n: 0, won: 0 };
				byRank[k].n++;
				if (t.playoffRoundsWon >= 1) byRank[k].won++;
			}
		}
	}
}
// Between two ranks, as for a tied team, the share is interpolated.
function shareAt(r) {
	const at = (k) => (byRank[k] ? byRank[k].won / byRank[k].n : 0);
	const lo = Math.floor(r);
	const hi = Math.ceil(r);
	return lo === hi ? at(lo) : at(lo) + (r - lo) * (at(hi) - at(lo));
}

const c = { cases: 0, noSeedChange: 0, intoPlayIn: 0, intoTopSix: 0, addedSeriesWins: 0, costsPlace: 0, placesLost: 0 };
for (const rep of reps) {
	const wait = {};
	for (const e of rep.seasonLog) {
		for (const t of e.teams) wait[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (wait[t.tid] ?? 0) + 1;
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 1).map((t) => ({ ...t, wait: wait[t.tid] }));
		const byConf = { E: e.teams.filter((t) => t.conf === "E"), W: e.teams.filter((t) => t.conf === "W") };
		for (const A of pool) {
			if (A.playoffRoundsWon >= 0) continue; // only teams that missed the playoffs
			for (const B of pool) {
				if (B.tid === A.tid || B.wait <= A.wait) continue;
				c.cases++;
				const before = (t) => t.wins;
				const after = (t) => t.wins + (t.tid === B.tid ? 1 : 0) - (t.tid === A.tid ? 1 : 0);
				const lost = place(pool, A, after) - place(pool, A, before);
				if (lost > 0) c.costsPlace++;
				c.placesLost += Math.max(0, lost);
				const seedCanChange = [...new Set([A.conf, B.conf])].some((k) => seedGroups(byConf[k], before) !== seedGroups(byConf[k], after));
				if (!seedCanChange) {
					c.noSeedChange++;
					continue;
				}
				const r0 = rank(byConf[B.conf], B.tid, before);
				const r1 = rank(byConf[B.conf], B.tid, after);
				if (r0 > PLAY_IN_LAST && r1 <= PLAY_IN_LAST + 0.5) c.intoPlayIn++;
				if (r0 > TOP_SIX && r1 <= TOP_SIX + 0.5) c.intoTopSix++;
				c.addedSeriesWins += Math.max(0, shareAt(r1) - shareAt(r0));
			}
		}
		for (const t of e.teams) if ((t.draftPick ?? 99) <= 3) wait[t.tid] = 0;
	}
}

const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
console.log(`\nSimple COLA, ${FILE}: ${reps.length} leagues\n`);
console.log("Share of teams that won a playoff series, by rank in the conference");
console.log(`   ${ranks.map((k) => `${k}: ${pct(byRank[k].won / byRank[k].n)}`).join("  ")}\n`);
console.log("A team that missed the playoffs loses one game to a pool rival with a longer wait");
console.log(`   cases: ${c.cases}`);
console.log(`   no seed can change, so no rival can leave the pool: ${c.noSeedChange} (${pct(c.noSeedChange / c.cases)})`);
console.log(`   the extra win lifts the rival into the play-in: ${c.intoPlayIn} (${pct(c.intoPlayIn / c.cases)})`);
console.log(`   the extra win lifts the rival into the top six seeds: ${c.intoTopSix} (${pct(c.intoTopSix / c.cases)})`);
console.log(`   the rival wins a series it otherwise would not, at most: ${c.addedSeriesWins.toFixed(0)} cases (${pct(c.addedSeriesWins / c.cases)})`);
console.log(`   the loss costs the team a place through the tie-break: ${c.costsPlace} (${pct(c.costsPlace / c.cases)})`);
console.log(`   per thrown game, places gained through the rival, at most: ${(c.addedSeriesWins / c.cases).toFixed(2)} (${(c.addedSeriesWins / c.cases).toFixed(4)})`);
console.log(`   per thrown game, places lost through the tie-break: ${(c.placesLost / c.cases).toFixed(2)} (${(c.placesLost / c.cases).toFixed(4)})\n`);
