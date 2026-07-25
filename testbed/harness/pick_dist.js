#!/usr/bin/env node
/**
 * Exact pick distribution for a top-D raffle followed by a deterministic tail.
 *
 * Every mechanism in this study has the same two-stage shape: draw the first D
 * picks from the lottery pool without replacement, proportional to a per-team
 * weight, then order the rest of the pool by a deterministic key. The three
 * mechanisms differ only in what fills those two slots:
 *
 *   Classic COLA   weight = drought index, tail = record (worst first)
 *   Waitlist COLA  weight = drought index, tail = drought index (longest first)
 *   NBA (2019-)    weight = ball count by record rank, tail = record (worst first)
 *
 * Because the shape is shared, the pick distribution can be computed EXACTLY
 * rather than sampled. The draw is Plackett-Luce (the engine implements it by
 * rejection sampling, which is distributionally identical), so enumerating the
 * D! * C(n,D) ordered prefixes gives every team's exact probability of each
 * lottery slot, and the C(n,D) unordered prefix sets give the exact conditional
 * tail position. For n=14 and D=4 that is 24,024 ordered prefixes and 1,001
 * sets, which runs in well under a millisecond per season.
 *
 * Exactness matters here. Both analyses this module serves are DIFFERENCES
 * between two closely related scenarios (a pool with one team swapped, a league
 * with one team's record moved). Monte Carlo would put sampling noise on both
 * sides of a difference that is often a fraction of a pick; the exact
 * computation makes a measured zero a real zero.
 *
 * Tie handling: teams tied on the tail key are ordered arbitrarily by the
 * mechanism (the engine's stable sort leaves them in team-id order, which is
 * uncorrelated with anything the mechanism rewards, and Waitlist COLA specifies
 * a random draw among equals). Either way the expectation over a record-blind
 * tie-break is the average of the tied positions, which is what this module
 * assigns.
 *
 * Exported: pickDistribution(pool, drawDepth) -> { p1, ePick, pPos }
 *   pool: [{ id, w, tailKey }]  w >= 0 raffle weight; HIGHER tailKey picks
 *                              earlier in the tail.
 *   p1[id]    exact probability of the first pick
 *   ePick[id] exact expected pick number (1-based) within the pool
 *   pPos[id]  [P(pick 1), ..., P(pick D)] for the raffle slots only
 */

"use strict";

// Enumerate ordered prefixes of length `depth` from `pool`, accumulating the
// probability of each (team, slot) pair and of each unordered prefix set.
function enumeratePrefixes(pool, depth) {
	const n = pool.length;
	const d = Math.min(depth, n);
	const pPos = pool.map(() => new Array(d).fill(0));
	const setProb = new Map(); // bitmask of drawn teams -> probability

	// Weights are non-negative; a zero-weight team can never win a raffle slot.
	// If the remaining weight is zero before the depth is exhausted, the engine
	// falls back to the tail order for the remaining slots, which is the same as
	// stopping the raffle early. `degenerate` counts those cases so callers can
	// assert they never happen on real data.
	let degenerate = 0;

	const recurse = (mask, remainingTotal, slot, prob) => {
		if (slot === d) {
			setProb.set(mask, (setProb.get(mask) ?? 0) + prob);
			return;
		}
		if (remainingTotal <= 0) {
			degenerate += 1;
			setProb.set(mask, (setProb.get(mask) ?? 0) + prob);
			return;
		}
		for (let i = 0; i < n; i++) {
			const bit = 1 << i;
			if (mask & bit) continue;
			const w = pool[i].w;
			if (w <= 0) continue;
			const p = prob * (w / remainingTotal);
			pPos[i][slot] += p;
			recurse(mask | bit, remainingTotal - w, slot + 1, p);
		}
	};

	const total = pool.reduce((s, t) => s + t.w, 0);
	recurse(0, total, 0, 1);
	return { pPos, setProb, degenerate, d };
}

function pickDistribution(pool, drawDepth = 4) {
	const n = pool.length;
	const { pPos, setProb, degenerate, d } = enumeratePrefixes(pool, drawDepth);

	const ePick = new Array(n).fill(0);
	const p1 = new Array(n).fill(0);
	for (let i = 0; i < n; i++) {
		p1[i] = pPos[i][0] ?? 0;
		for (let k = 0; k < d; k++) ePick[i] += (k + 1) * pPos[i][k];
	}

	// Conditional on the set of raffle winners, every remaining team's tail pick
	// is determined by how many other remaining teams outrank it on the tail key.
	for (const [mask, prob] of setProb) {
		if (prob === 0) continue;
		const rest = [];
		for (let i = 0; i < n; i++) if (!(mask & (1 << i))) rest.push(i);
		const drawn = n - rest.length; // teams already assigned raffle slots
		for (const i of rest) {
			let better = 0;
			let equal = 0;
			for (const j of rest) {
				if (j === i) continue;
				if (pool[j].tailKey > pool[i].tailKey) better += 1;
				else if (pool[j].tailKey === pool[i].tailKey) equal += 1;
			}
			ePick[i] += prob * (drawn + 1 + better + equal / 2);
		}
	}

	const byId = (arr) => {
		const o = {};
		for (let i = 0; i < n; i++) o[pool[i].id] = arr[i];
		return o;
	};
	return {
		p1: byId(p1),
		ePick: byId(ePick),
		pPos: byId(pPos),
		degenerate,
	};
}

// --- Mechanism definitions ---------------------------------------------------

// Official post-2019 NBA pick-1 ball counts by record rank within the 14-team
// lottery pool (worst record first), per 1000.
const NBA_BALLS = [140, 140, 140, 125, 105, 90, 75, 60, 45, 30, 20, 15, 10, 5];

/**
 * Build the raffle-weight / tail-key pool for one mechanism from a set of teams.
 * teams: [{ tid, wins, colaPre }] -- the lottery pool for one season.
 */
function buildPool(teams, mech) {
	if (mech === "nba") {
		// Ball counts follow the record rank, so the pool must be ranked first.
		// Teams tied on record share the rank block; the engine assigns by its
		// stable sort, and the ball counts inside a tie block differ, so we take
		// the ranks as sorted (matching the driver, which sorts by wins).
		const ranked = teams.slice().sort((a, b) => a.wins - b.wins);
		return ranked.map((t, i) => ({
			id: t.tid,
			w: NBA_BALLS[i] ?? NBA_BALLS[NBA_BALLS.length - 1],
			tailKey: -t.wins,
		}));
	}
	if (mech === "classic") {
		return teams.map((t) => ({ id: t.tid, w: t.colaPre, tailKey: -t.wins }));
	}
	if (mech === "waitlist") {
		return teams.map((t) => ({ id: t.tid, w: t.colaPre, tailKey: t.colaPre }));
	}
	throw new Error(`unknown mechanism ${mech}`);
}

const MECHS = ["nba", "classic", "waitlist"];

module.exports = { pickDistribution, buildPool, MECHS, NBA_BALLS };
