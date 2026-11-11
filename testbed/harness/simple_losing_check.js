#!/usr/bin/env node
/**
 * Section 4's numbers for Simple COLA, from the 25-season run.
 *
 * Reads runs/frontier/simplerule.json (30 leagues x 25 seasons) and replays the
 * rule exactly as the driver runs it (colaFullEngineDriver.test.ts,
 * computeAnchorOrder, variant "simplerule"):
 *   wait   seasons since the team last won a playoff series or its own draft
 *          slot fell in the first three. A series win sets it to 0, any other
 *          season adds 1 after the playoffs, and the first three picks go back
 *          to 0 after the draft.
 *   pool   the 22 teams without a series win this season.
 *   order  longest wait first, then most wins, then a coin flip.
 *
 * It prints four checks.
 * 1. Rule against the simulator. The order the simulator recorded (draftPick)
 *    must never place a pool team ahead of one with a longer wait, or ahead of
 *    one with the same wait and more wins.
 * 2. Losing sweep (the 158,325 cases first reported on 2026-09-28). In each
 *    season take every team that missed the playoffs except the one with the
 *    fewest wins. Lower its win total one game at a time, down to one win below
 *    that fewest-wins total, hold everything else as it happened, and recompute
 *    its place in the order. A coin-flip tie counts at its mean place, which is
 *    half a place per tied team.
 * 3. One more loss. The same recomputation for exactly one win fewer, for all
 *    14 teams that missed the playoffs.
 * 4. Wins and series wins. The share of team-seasons that won a playoff series,
 *    in five-win bands, and the largest rise per extra win between neighbouring
 *    bands. The band width is a reporting choice and enters no other result.
 *
 * With --cutoff it also prints how often the line between the third and fourth
 * picks falls between two teams with the same wait, and what those two teams
 * received in the drafts that followed.
 *
 * Usage: node simple_losing_check.js [--cutoff] [file=runs/frontier/simplerule.json]
 */

"use strict";

const fs = require("fs");

const ARGS = process.argv.slice(2);
const FILE = ARGS.find((a) => !a.startsWith("--")) ?? "runs/frontier/simplerule.json";
const CUTOFF = ARGS.includes("--cutoff");

// Every league starts with no history, so all teams share one wait at first.
// The longest wait under Simple COLA averages 5.5 seasons (abstract_table.js
// --table1), so waits cannot reach their usual spread before season 6. The
// cutoff figures are printed for all seasons and for seasons after these.
const START_UP_SEASONS = 5;
// Width of the win bands in check 4, in wins. Reporting choice only.
const BAND = 5;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a) => {
	const s = a.slice().sort((x, y) => x - y);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const share = (a, test) => a.filter(test).length / a.length;
const pct = (x) => `${(100 * x).toFixed(1)}%`;

const reps = JSON.parse(fs.readFileSync(FILE, "utf8"));

// Place of one pool team if it had finished with `wins`, everything else held.
function place(pool, me, wins) {
	let ahead = 0;
	let tied = 0;
	for (const o of pool) {
		if (o.tid === me.tid) continue;
		if (o.wait > me.wait || (o.wait === me.wait && o.wins > wins)) ahead++;
		else if (o.wait === me.wait && o.wins === wins) tied++;
	}
	return 1 + ahead + tied / 2;
}

let seasons = 0;
let pairs = 0;
let pairsBroken = 0;
const sweep = { cases: 0, earlier: 0, later: 0, same: 0, maxGain: -Infinity };
const oneLoss = [];
const byWins = {};
const cut = { all: { n: 0, split: 0 }, late: { n: 0, split: 0 }, group: [], need: [], nextIn: [], nextOut: [], sum3In: [], sum3Out: [], sum6In: [], sum6Out: [] };

for (const rep of reps) {
	const wait = {};
	const log = rep.seasonLog;
	for (let s = 0; s < log.length; s++) {
		const e = log[s];
		for (const t of e.teams) {
			wait[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (wait[t.tid] ?? 0) + 1;
			const b = (byWins[t.wins] ??= { n: 0, won: 0 });
			b.n++;
			if (t.playoffRoundsWon >= 1) b.won++;
		}
		const pool = e.teams
			.filter((t) => t.playoffRoundsWon < 1)
			.map((t) => ({ tid: t.tid, wait: wait[t.tid], wins: t.wins, pick: t.draftPick }));
		const order = pool.slice().sort((a, b) => a.pick - b.pick);
		seasons++;

		// 1. the recorded order against the rule
		for (let i = 0; i + 1 < order.length; i++) {
			pairs++;
			const a = order[i];
			const b = order[i + 1];
			if (a.wait < b.wait || (a.wait === b.wait && a.wins < b.wins)) pairsBroken++;
		}

		// 2 and 3. losing, for the teams that missed the playoffs
		const missed = pool
			.filter((p) => e.teams.find((t) => t.tid === p.tid).playoffRoundsWon < 0)
			.sort((a, b) => a.wins - b.wins);
		const floor = missed[0].wins - 1;
		for (let r = 1; r < missed.length; r++) {
			const me = missed[r];
			const actual = place(pool, me, me.wins);
			for (let w = me.wins - 1; w >= floor; w--) {
				const gain = actual - place(pool, me, w);
				sweep.cases++;
				sweep.maxGain = Math.max(sweep.maxGain, gain);
				if (gain > 0) sweep.earlier++;
				else if (gain < 0) sweep.later++;
				else sweep.same++;
			}
		}
		for (const me of missed) oneLoss.push(place(pool, me, me.wins - 1) - place(pool, me, me.wins));

		// --cutoff: the line between the third and fourth picks
		const third = order[2];
		const fourth = order[3];
		const late = s >= START_UP_SEASONS;
		cut.all.n++;
		if (late) cut.late.n++;
		if (third.wait === fourth.wait) {
			cut.all.split++;
			if (late) {
				cut.late.split++;
				cut.group.push(order.filter((o) => o.wait === third.wait).length);
				cut.need.push(third.wins - fourth.wins + 1);
				const later = (tid, k) => log[s + k].teams.find((t) => t.tid === tid).draftPick;
				if (s + 1 < log.length) {
					cut.nextIn.push(later(third.tid, 1));
					cut.nextOut.push(later(fourth.tid, 1));
				}
				if (s + 2 < log.length) {
					cut.sum3In.push(3 + later(third.tid, 1) + later(third.tid, 2));
					cut.sum3Out.push(4 + later(fourth.tid, 1) + later(fourth.tid, 2));
				}
				if (s + 5 < log.length) {
					let a = 3;
					let b = 4;
					for (let k = 1; k <= 5; k++) {
						a += later(third.tid, k);
						b += later(fourth.tid, k);
					}
					cut.sum6In.push(a);
					cut.sum6Out.push(b);
				}
			}
		}

		for (const t of e.teams) if ((t.draftPick ?? 99) <= 3) wait[t.tid] = 0;
	}
}

console.log(`\nSimple COLA, ${FILE}: ${reps.length} leagues, ${seasons} seasons\n`);

console.log("1. Rule against the simulator");
console.log(`   neighbouring pool picks out of order under the rule: ${pairsBroken} of ${pairs}\n`);

console.log("2. Losing sweep, teams that missed the playoffs (all but the fewest-wins team)");
console.log(`   cases: ${sweep.cases}`);
console.log(`   place earlier: ${sweep.earlier} | later: ${sweep.later} (${pct(sweep.later / sweep.cases)}) | unchanged: ${sweep.same}`);
console.log(`   largest gain in places: ${sweep.maxGain}\n`);

console.log("3. One more loss, the 14 teams that missed the playoffs");
console.log(`   team-seasons: ${oneLoss.length} | mean places lost: ${mean(oneLoss).toFixed(3)} | share where it cost nothing: ${pct(share(oneLoss, (x) => x === 0))}\n`);

console.log("4. Wins and series wins, all team-seasons");
const wins = Object.keys(byWins).map(Number);
const bands = [];
for (let lo = Math.floor(Math.min(...wins) / BAND) * BAND; lo <= Math.max(...wins); lo += BAND) {
	let n = 0;
	let won = 0;
	for (let w = lo; w < lo + BAND; w++) {
		if (byWins[w]) {
			n += byWins[w].n;
			won += byWins[w].won;
		}
	}
	if (n > 0) bands.push({ lo, hi: lo + BAND - 1, n, won, p: won / n });
}
console.log(`   team-seasons: ${bands.reduce((s, b) => s + b.n, 0)}`);
for (const b of bands) {
	if (b.lo >= 30 && b.lo < 65) console.log(`   ${b.lo}-${b.hi} wins: ${b.won} of ${b.n} won a series (${pct(b.p)})`);
}
let steep = { rise: 0 };
for (let i = 0; i + 1 < bands.length; i++) {
	const rise = (bands[i + 1].p - bands[i].p) / BAND;
	if (rise > steep.rise) steep = { rise, from: bands[i], to: bands[i + 1] };
}
console.log(`   steepest rise between neighbouring bands: ${(100 * steep.rise).toFixed(1)} points per extra win (${steep.from.lo}-${steep.from.hi} to ${steep.to.lo}-${steep.to.hi})\n`);

if (CUTOFF) {
	console.log("Cutoff between the third and fourth picks");
	console.log(`   third and fourth teams share a wait: ${cut.all.split} of ${cut.all.n} seasons (${pct(cut.all.split / cut.all.n)})`);
	console.log(`   same, after the ${START_UP_SEASONS} start-up seasons: ${cut.late.split} of ${cut.late.n} (${pct(cut.late.split / cut.late.n)})`);
	console.log("   The lines below use those seasons after start-up.");
	console.log(`   teams sharing that wait: mean ${mean(cut.group).toFixed(2)}, median ${median(cut.group)}`);
	console.log(`   extra losses the third team needed to fall behind the fourth: median ${median(cut.need)}, mean ${mean(cut.need).toFixed(2)} | 2 or fewer: ${pct(share(cut.need, (x) => x <= 2))} | 5 or fewer: ${pct(share(cut.need, (x) => x <= 5))}`);
	console.log(`   next season's pick (n=${cut.nextIn.length}): third team mean ${mean(cut.nextIn).toFixed(2)}, median ${median(cut.nextIn)} | fourth team mean ${mean(cut.nextOut).toFixed(2)}, median ${median(cut.nextOut)}`);
	console.log(`   top-three pick next season: third team ${pct(share(cut.nextIn, (p) => p <= 3))} | fourth team ${pct(share(cut.nextOut, (p) => p <= 3))}`);
	console.log(`   pick numbers summed over three drafts (n=${cut.sum3In.length}): third team ${mean(cut.sum3In).toFixed(2)} | fourth team ${mean(cut.sum3Out).toFixed(2)}`);
	console.log(`   pick numbers summed over six drafts (n=${cut.sum6In.length}): third team ${mean(cut.sum6In).toFixed(2)} | fourth team ${mean(cut.sum6Out).toFixed(2)}\n`);
}
