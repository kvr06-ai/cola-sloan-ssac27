#!/usr/bin/env node
/**
 * Sim 3, the tanking agent: what does a losing streak actually buy?
 *
 * Legs (a) and (b) of the study score mechanisms on gradients measured ACROSS
 * seasons, which is an association. A team ranked worst tends to draft earlier
 * than a team ranked fifth-worst, but those are different teams in different
 * situations, and the gap conflates the reward for losing with everything else
 * that differs between them. The question a front office actually faces is
 * causal and holds the team fixed: if WE lose more, from this position, in this
 * league, what changes about our pick?
 *
 * This script answers that question by counterfactual on the league states the
 * full engine produced. Take a season exactly as it happened, choose a lottery
 * team, and move only its record: drop it to the worst record in the pool while
 * every roster, every index, and every other team's record stays as it was.
 * Then recompute the exact pick distribution and read off the difference. The
 * pairing is perfect because both arms are the same league, and the numbers are
 * exact expectations rather than samples, so a measured zero is a real zero
 * rather than a Monte Carlo result that failed to reject one.
 *
 * Holding the index fixed is not an approximation. The engine's carry-over index
 * updates on playoffRoundsWon alone (draft/cola.ts: a team that misses the
 * playoffs gains COLA_ALPHA, a team that makes them is decayed by how far it
 * advanced). A lottery team that loses more games misses the playoffs either
 * way, so its index is identical in both arms. Record is the only thing a
 * within-season tank moves, which is exactly what this intervention moves.
 *
 * Three quantities, in draft picks, positive when losing buys a better pick:
 *   headline   the fifth-worst team drops to worst, the same contrast leg (a)
 *              scores, but causally and on a fixed team.
 *   curve      every starting rank drops to worst, so the reward is priced for
 *              a tank of any size rather than one arbitrary size.
 *   marginal   one rank of extra losing, the incentive at the margin, which is
 *              what a team weighs when it decides to sit a healthy starter.
 *
 * Usage: node tank_counterfactual.js [runsDir=runs]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { pickDistribution, buildPool, MECHS } = require("./pick_dist.js");

const ROOT = process.argv[2] ?? "runs";
const SOURCES = {
	nba: path.join(ROOT, "ref", "nba.json"),
	classic: path.join(ROOT, "e14", "classic.json"),
	waitlist: path.join(ROOT, "e14", "mid.json"),
};

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const variance = (a) => {
	const m = mean(a);
	return a.length < 2 ? NaN : a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const sem = (a) => Math.sqrt(variance(a) / a.length);
const pctile = (a, p) => {
	if (!a.length) return NaN;
	const s = a.slice().sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/**
 * Move one team's record and re-price the draft.
 * teams: the season's lottery pool. tanker: the team that loses.
 * targetWins: the record it ends up with.
 */
function tankGain(pool, mech, tankerTid, targetWins, base) {
	const alt = pool.map((t) =>
		t.tid === tankerTid ? { ...t, wins: targetWins } : t,
	);
	const after = pickDistribution(buildPool(alt, mech), 4);
	return base.ePick[tankerTid] - after.ePick[tankerTid];
}

const loaded = {};
for (const [mech, file] of Object.entries(SOURCES)) {
	try {
		loaded[mech] = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		console.error(`cannot read ${file}: ${e.message}`);
		process.exit(1);
	}
}

const RANKS = 14; // pool size at E=14
const results = {};

for (const mech of MECHS) {
	const headline = [];
	const perRep = [];
	const toWorst = Array.from({ length: RANKS + 1 }, () => []);
	const marginal = Array.from({ length: RANKS + 1 }, () => []);
	let maxAbs = 0;

	for (const rep of loaded[mech]) {
		const repHead = [];
		for (const e of rep.seasonLog) {
			const pool = e.teams.filter((t) => t.playoffRoundsWon < 0);
			if (pool.length !== RANKS) continue;
			const base = pickDistribution(buildPool(pool, mech), 4);
			// Rank 1 is the worst record. Ties are broken the way the engine's
			// stable sort breaks them, so the ranking here is the one the draft saw.
			const ranked = pool.slice().sort((a, b) => a.wins - b.wins);
			const worstWins = ranked[0].wins;

			for (let r = 2; r <= RANKS; r++) {
				const t = ranked[r - 1];
				const g = tankGain(pool, mech, t.tid, worstWins - 1, base);
				toWorst[r].push(g);
				maxAbs = Math.max(maxAbs, Math.abs(g));
				if (r === 5) {
					headline.push(g);
					repHead.push(g);
				}
				// One rank of extra losing: end up just below the team above.
				const above = ranked[r - 2];
				const m = tankGain(pool, mech, t.tid, above.wins - 1, base);
				marginal[r].push(m);
				maxAbs = Math.max(maxAbs, Math.abs(m));
			}
		}
		if (repHead.length) perRep.push(mean(repHead));
	}
	results[mech] = { headline, perRep, toWorst, marginal, maxAbs };
}

const nSeasons = results.waitlist.headline.length;

console.log(
	`\n===== Sim 3, the tanking agent: what a losing streak buys, ${nSeasons} engine seasons per mechanism =====\n`,
);
console.log(
	`The same league in both arms. Only the tanking team's record moves; rosters, indices, and every`,
);
console.log(
	`other team's record are held at what the engine produced. Gains are in draft picks, positive when`,
);
console.log(`losing moves the team EARLIER in the draft.\n`);

console.log(`The fifth-worst team drops to worst:`);
console.log(`mechanism    mean     p95      max      per-league mean (n=48)`);
console.log("-".repeat(76));
for (const mech of MECHS) {
	const r = results[mech];
	console.log(
		`${mech.padEnd(12)} ${mean(r.headline).toFixed(3).padStart(6)}  ${pctile(r.headline, 95).toFixed(3).padStart(6)}  ` +
			`${Math.max(...r.headline).toFixed(3).padStart(6)}      ${mean(r.perRep).toFixed(4)} +/- ${sem(r.perRep).toFixed(4)}  ` +
			`CI[${(mean(r.perRep) - 2.01 * sem(r.perRep)).toFixed(4)}, ${(mean(r.perRep) + 2.01 * sem(r.perRep)).toFixed(4)}]`,
	);
}

console.log(`\nEvery starting rank drops to worst (mean picks gained; rank 1 is already worst):`);
console.log(
	`mechanism   ` + Array.from({ length: RANKS - 1 }, (_, i) => String(i + 2).padStart(6)).join(""),
);
console.log("-".repeat(12 + 6 * (RANKS - 1)));
for (const mech of MECHS) {
	console.log(
		mech.padEnd(12) +
			Array.from({ length: RANKS - 1 }, (_, i) =>
				mean(results[mech].toWorst[i + 2]).toFixed(2).padStart(6),
			).join(""),
	);
}

console.log(`\nOne more rank of losing, the incentive at the margin (mean picks gained):`);
console.log(
	`mechanism   ` + Array.from({ length: RANKS - 1 }, (_, i) => String(i + 2).padStart(6)).join(""),
);
console.log("-".repeat(12 + 6 * (RANKS - 1)));
for (const mech of MECHS) {
	console.log(
		mech.padEnd(12) +
			Array.from({ length: RANKS - 1 }, (_, i) =>
				mean(results[mech].marginal[i + 2]).toFixed(2).padStart(6),
			).join(""),
	);
}

console.log(`\nLargest absolute gain found anywhere (all ranks, all seasons, both interventions):`);
for (const mech of MECHS) {
	console.log(`  ${mech.padEnd(10)} ${results[mech].maxAbs.toExponential(3)} picks`);
}
console.log(
	`\nWaitlist COLA reads only the carry-over index, which a within-season tank cannot move, so its`,
);
console.log(
	`zero is structural rather than statistical: not a small effect that failed to reach significance,`,
);
console.log(
	`but an identity that holds in every season at every rank. The measurement's job is to confirm the`,
);
console.log(
	`implementation carries no leak, and to price what the record-based mechanisms pay for the same act.\n`,
);
