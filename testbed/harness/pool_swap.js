#!/usr/bin/env node
/**
 * Q3, pool manipulation: what does shrinking the lottery pool buy under
 * Waitlist COLA?
 *
 * Theorem 1 of the manipulation-bound paper covers a raffle whose odds are a
 * team's share of the pool's total index. A team can attack that denominator:
 * lose deliberately to the best non-playoff team so that team climbs into the
 * playoffs, which pushes the worst playoff team out and into the lottery pool.
 * The pool total changes by Delta = L_h - L_ell, and every remaining team's
 * share of the raffle moves with it. The bound is about 4 percentage points of
 * pick-one probability, and it holds because of structural anti-correlation:
 * the teams with the longest droughts sit far from the playoff boundary, so the
 * index a manipulator can actually move in or out of the pool is small.
 *
 * Waitlist COLA inherits that raffle unchanged for the top four picks, so the
 * bound transfers verbatim. What it does NOT inherit is the tail. Classic COLA
 * and the NBA order picks 5-14 by record, which no pool swap can touch, because
 * the swap happens at the top-record edge of the pool. Waitlist orders picks
 * 5-14 by the drought index, so removing a long-drought team from the pool
 * moves everyone below it up a pick, and admitting a long-drought playoff team
 * pushes everyone below IT down a pick. That is a second manipulation channel
 * with no counterpart in the other two mechanisms, and it is the reason Q3 needs
 * its own measurement rather than a citation of the top-four bound.
 *
 * The statistic is therefore the expected DRAFT PICK a manipulator gains, not
 * just its pick-one probability. Expected pick is what a front office would act
 * on, it is the same unit as the other two legs of the study, and it is the only
 * unit in which the tail channel is visible at all.
 *
 * Method. For every season the full engine produced, take the realized pool,
 * records, and pre-draw indices. Compute each pool team's exact expected pick
 * (pick_dist.js). Then apply the boundary swap in each conference and recompute.
 * The manipulation gain for team i is its baseline expected pick minus its
 * post-swap expected pick, so positive means the swap helped. A manipulator
 * picks the conference and gets to be whichever pool team benefits most, so the
 * headline per season is the maximum over both.
 *
 * Two deliberate conservatisms, both of which understate the record-based
 * mechanisms rather than Waitlist:
 *   - The manipulator's own record is held fixed. Losing the games that push the
 *     ninth seed up would also drop the manipulator down the standings, which
 *     helps under Classic and the NBA (record-ordered tails, record-ranked ball
 *     counts) and does nothing under Waitlist.
 *   - The gain is credited even when it is worth less than the games thrown away.
 *
 * Usage: node pool_swap.js [--validate] [runsDir=runs]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { pickDistribution, buildPool, MECHS } = require("./pick_dist.js");

const ALPHA = 1000; // engine index scale: colaPre / ALPHA ~ drought-years

const ARGS = process.argv.slice(2);
const VALIDATE = ARGS.includes("--validate");
const ROOT = ARGS.find((a) => !a.startsWith("--")) ?? "runs";

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

// The Theorem-1 closed form, kept as an independent check on the top-four leg:
// a team with index L_i in a pool of total P gains L_i * Delta / (P * (P-Delta))
// of pick-one probability when the pool total drops by Delta.
const theoremGain = (Li, P, Delta) =>
	Delta > 0 && P - Delta > 0 ? (Li * Delta) / (P * (P - Delta)) : 0;

/**
 * One season, one mechanism. Returns the best manipulation gain available and
 * the diagnostics behind it.
 */
function seasonSwap(teams, mech) {
	const pool = teams.filter((t) => t.playoffRoundsWon < 0);
	const playoff = teams.filter((t) => t.playoffRoundsWon >= 0);
	if (pool.length < 5 || !playoff.length) return null;

	const base = pickDistribution(buildPool(pool, mech), 4);
	const P = pool.reduce((s, t) => s + t.colaPre, 0);
	const Lmax = Math.max(...pool.map((t) => t.colaPre));
	const longest = pool.slice().sort((a, b) => b.colaPre - a.colaPre)[0];

	let best = { dPick: -Infinity, dP1: -Infinity };
	let theorem = 0;
	let longestGain = -Infinity;
	let poolMean = -Infinity;

	for (const conf of ["E", "W"]) {
		const cPool = pool.filter((t) => t.conf === conf);
		const cPlay = playoff.filter((t) => t.conf === conf);
		if (!cPool.length || !cPlay.length) continue;
		// h: best-record non-playoff team, pushed INTO the playoffs.
		// ell: worst-record playoff team, displaced INTO the pool.
		const h = cPool.slice().sort((a, b) => b.wins - a.wins)[0];
		const ell = cPlay.slice().sort((a, b) => a.wins - b.wins)[0];
		const swapped = pool.filter((t) => t.tid !== h.tid).concat([ell]);
		const alt = pickDistribution(buildPool(swapped, mech), 4);

		theorem = Math.max(theorem, theoremGain(Lmax, P, h.colaPre - ell.colaPre));
		const gains = [];
		for (const t of pool) {
			if (t.tid === h.tid) continue;
			const dPick = base.ePick[t.tid] - alt.ePick[t.tid];
			const dP1 = alt.p1[t.tid] - base.p1[t.tid];
			gains.push(dPick);
			if (dPick > best.dPick) best = { dPick, dP1 };
			if (t.tid === longest.tid && dPick > longestGain) longestGain = dPick;
		}
		poolMean = Math.max(poolMean, mean(gains));
	}
	if (!Number.isFinite(best.dPick)) return null;
	return {
		dPick: best.dPick,
		dP1: best.dP1,
		theorem,
		longest: Number.isFinite(longestGain) ? longestGain : 0,
		poolMean,
	};
}

/**
 * Model-vs-engine fidelity, in three tests.
 *
 * The per-season picks sum to 105 under both the model and the engine, so any
 * aggregate mean matches by construction and proves nothing. These three do not.
 *
 *   structure   the pool the model scores (the 14 non-playoff teams) is exactly
 *               the set of teams the engine handed picks 1-14.
 *   tail        conditional on the raffle winners the engine actually drew, every
 *               remaining pick is deterministic, so the model must reproduce it
 *               exactly rather than on average. Teams tied on the tail key are
 *               ordered by the engine's own tie-break, so those are scored as
 *               correct anywhere inside their tie block.
 *   raffle      the model's exact pick-one probability against the frequency the
 *               engine's draw realized, in bins across the probability range.
 */
function validate(reps, mech, label) {
	const BINS = 6;
	const rows = [];
	let degenerate = 0;
	let badPool = 0;
	let seasons = 0;
	let tailObs = 0;
	let tailMiss = 0;
	let tailTied = 0;

	for (const rep of reps) {
		for (const e of rep.seasonLog) {
			const pool = e.teams.filter((t) => t.playoffRoundsWon < 0);
			seasons += 1;
			const top14 = new Set(e.teams.filter((t) => t.draftPick <= 14).map((t) => t.tid));
			if (pool.length !== 14 || pool.some((t) => !top14.has(t.tid))) {
				badPool += 1;
				continue;
			}
			const bp = buildPool(pool, mech);
			const key = {};
			for (const t of bp) key[t.id] = t.tailKey;
			const d = pickDistribution(bp, 4);
			degenerate += d.degenerate;
			for (const t of pool) rows.push([d.p1[t.tid], t.draftPick === 1 ? 1 : 0]);

			// Deterministic-tail test against the engine's realized raffle winners.
			const rest = pool.filter((t) => t.draftPick > 4);
			for (const t of rest) {
				let better = 0;
				let equal = 0;
				for (const u of rest) {
					if (u.tid === t.tid) continue;
					if (key[u.tid] > key[t.tid]) better += 1;
					else if (key[u.tid] === key[t.tid]) equal += 1;
				}
				const implied = 5 + better;
				if (equal > 0) tailTied += 1;
				if (t.draftPick < implied || t.draftPick > implied + equal) tailMiss += 1;
				tailObs += 1;
			}
		}
	}

	rows.sort((a, b) => a[0] - b[0]);
	const per = Math.floor(rows.length / BINS);
	const zs = [];
	for (let b = 0; b < BINS; b++) {
		const slice = rows.slice(b * per, b === BINS - 1 ? rows.length : (b + 1) * per);
		const m = mean(slice.map((r) => r[0]));
		const f = mean(slice.map((r) => r[1]));
		zs.push((f - m) / Math.sqrt((f * (1 - f)) / slice.length));
	}
	console.log(
		`  ${label.padEnd(9)} structure ${seasons - badPool}/${seasons} seasons   ` +
			`tail ${tailObs - tailMiss}/${tailObs} picks exact (${tailTied} inside a tie block)   ` +
			`raffle max |z| ${Math.max(...zs.map(Math.abs)).toFixed(2)} over ${BINS} bins   ` +
			`degenerate draws ${degenerate}`,
	);
}

// --- main --------------------------------------------------------------------

const loaded = {};
for (const [mech, file] of Object.entries(SOURCES)) {
	try {
		loaded[mech] = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		console.error(`cannot read ${file}: ${e.message}`);
		process.exit(1);
	}
}

if (VALIDATE) {
	console.log(`\nModel-vs-engine fidelity, exact expectation against the engine's own draw:`);
	for (const mech of MECHS) validate(loaded[mech], mech, mech);
	console.log(
		`  The tail test is the strong one: those picks are deterministic given the winners the engine`,
	);
	console.log(
		`  drew, so the model has to match every one of them rather than match on average.\n`,
	);
}

const summary = {};
for (const mech of MECHS) {
	const s = { dPick: [], dP1: [], thm: [], longest: [], poolMean: [], perRep: [] };
	for (const rep of loaded[mech]) {
		const repPick = [];
		for (const e of rep.seasonLog) {
			const r = seasonSwap(e.teams, mech);
			if (!r) continue;
			s.dPick.push(r.dPick);
			s.dP1.push(r.dP1);
			s.thm.push(r.theorem);
			s.longest.push(r.longest);
			s.poolMean.push(r.poolMean);
			repPick.push(r.dPick);
		}
		if (repPick.length) s.perRep.push(mean(repPick));
	}
	summary[mech] = s;
}

const nSeasons = summary.waitlist.dPick.length;
console.log(
	`\n===== Q3, pool manipulation: what a boundary swap buys, ${nSeasons} engine seasons per mechanism =====\n`,
);
console.log(
	`A manipulator throws games to the best non-playoff team so it climbs into the playoffs, which`,
);
console.log(
	`displaces the worst playoff team into the lottery pool. Gains are in draft picks, positive when`,
);
console.log(`the swap moves a team EARLIER in the draft.\n`);

console.log(`             best beneficiary in the season          average       longest-drought`);
console.log(`mechanism    mean     p95      max      helps in     pool team     team`);
console.log("-".repeat(88));
for (const mech of MECHS) {
	const s = summary[mech];
	const posShare = (100 * s.dPick.filter((x) => x > 1e-12).length) / s.dPick.length;
	console.log(
		`${mech.padEnd(12)} ${mean(s.dPick).toFixed(3).padStart(6)}  ${pctile(s.dPick, 95).toFixed(3).padStart(6)}  ` +
			`${Math.max(...s.dPick).toFixed(3).padStart(6)}  ${(posShare.toFixed(0) + "%").padStart(9)}     ` +
			`${mean(s.poolMean).toFixed(3).padStart(7)}       ${mean(s.longest).toFixed(3).padStart(7)}`,
	);
}
console.log(`\nPer-replicate mean of the best-beneficiary gain (n=48 independent leagues):`);
for (const mech of MECHS) {
	const r = summary[mech].perRep;
	console.log(
		`  ${mech.padEnd(10)} ${mean(r).toFixed(4)} +/- ${sem(r).toFixed(4)} picks  ` +
			`CI[${(mean(r) - 2.01 * sem(r)).toFixed(4)}, ${(mean(r) + 2.01 * sem(r)).toFixed(4)}]`,
	);
}

console.log(`\nThe pick-one probability channel Theorem 1 bounds, in percentage points:`);
console.log(`mechanism    measured max    Theorem-1 closed form max`);
console.log("-".repeat(60));
for (const mech of MECHS) {
	const s = summary[mech];
	const thm =
		mech === "nba" ? "not applicable" : (100 * Math.max(...s.thm)).toFixed(2) + "%";
	console.log(
		`${mech.padEnd(12)} ${(100 * Math.max(...s.dP1)).toFixed(2).padStart(8)}%       ${thm}`,
	);
}
console.log(
	`\nClassic COLA and Waitlist COLA share the top-four raffle exactly, so the closed form applies to`,
);
console.log(
	`both; each is evaluated on the index distribution its own engine arm produced. The NBA weights`,
);
console.log(
	`its raffle by record rank rather than by index, so the index-based closed form does not apply.\n`,
);
