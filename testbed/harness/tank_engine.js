#!/usr/bin/env node
/**
 * Sim 3, behavioral arm: read out the paired tank-vs-control engine runs.
 *
 * tank_counterfactual.js prices the draft rule in isolation by moving a record
 * and holding the rest of the league still. That is the clean causal estimate of
 * what the RULE rewards, but a front office that tanks does not move only its own
 * record. The games it stops winning are won by somebody, which can change who
 * makes the playoffs, which changes who is in the lottery pool and what the
 * pool's index profile looks like. Those consequences are invisible to a
 * counterfactual that freezes everything else, and they are exactly what the
 * engine run captures.
 *
 * Each pair of runs shares a config id and a seed, so the two leagues are the
 * same league until the shutdown. Two readouts per mechanism:
 *
 *   realized    the pick the team actually received, tank arm against control.
 *               This is what a general manager would observe, and it carries the
 *               lottery's own variance, so it is noisy by construction.
 *   expected    the exact expected pick implied by each arm's realized end-of-
 *               season state. This strips the luck of the draw and leaves the
 *               change in the team's draft POSITION, which is what the tank was
 *               bought to move.
 *
 * Usage: node tank_engine.js [runsDir=runs/tank]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { pickDistribution, buildPool, MECHS } = require("./pick_dist.js");

const DIR = process.argv[2] ?? path.join("runs", "tank");

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const variance = (a) => {
	const m = mean(a);
	return a.length < 2 ? NaN : a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const sem = (a) => Math.sqrt(variance(a) / a.length);
const ci = (a) => `CI[${(mean(a) - 2.01 * sem(a)).toFixed(3)}, ${(mean(a) + 2.01 * sem(a)).toFixed(3)}]`;

const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));

function tankSeasonOf(seasonLog) {
	return seasonLog.find((e) => e.tankedTid != null) ?? null;
}

function poolRank(teams, tid) {
	const pool = teams.filter((t) => t.playoffRoundsWon < 0);
	const idx = pool.slice().sort((a, b) => a.wins - b.wins).findIndex((t) => t.tid === tid);
	return idx < 0 ? null : idx + 1;
}

function expectedPick(teams, tid, mech) {
	const pool = teams.filter((t) => t.playoffRoundsWon < 0);
	if (pool.length !== 14 || !pool.some((t) => t.tid === tid)) return null;
	return pickDistribution(buildPool(pool, mech), 4).ePick[tid];
}

console.log(`\n===== Sim 3, behavioral arm: a real tank inside the full engine =====\n`);
console.log(
	`At the midpoint of one season the fifth-worst team sits its five best players and the engine plays`,
);
console.log(
	`the rest of the year out. The control arm is the same league, same seed, same games, nobody sat.`,
);
console.log(
	`Deltas are tank arm minus control; a positive pick delta means the tank drafted EARLIER.\n`,
);

console.log(
	`mechanism    n   wins      pool rank   left the pool   realized pick        expected pick`,
);
console.log("-".repeat(108));

for (const mech of MECHS) {
	let tankArm;
	let ctrlArm;
	try {
		tankArm = load(`${mech}_tank.json`);
		ctrlArm = load(`${mech}_ctrl.json`);
	} catch (e) {
		console.log(`${mech.padEnd(12)} not run yet (${e.message})`);
		continue;
	}
	const bySeed = new Map(ctrlArm.map((r) => [r.seed, r]));
	const dWins = [];
	const dRank = [];
	const dReal = [];
	const dExp = [];
	let left = 0;
	let mismatched = 0;

	for (const rt of tankArm) {
		const rc = bySeed.get(rt.seed);
		if (!rc) continue;
		const st = tankSeasonOf(rt.seasonLog);
		const sc = tankSeasonOf(rc.seasonLog);
		if (!st || !sc || st.tankedTid !== sc.tankedTid) {
			mismatched += 1;
			continue;
		}
		const tid = st.tankedTid;
		const tt = st.teams.find((t) => t.tid === tid);
		const tc = sc.teams.find((t) => t.tid === tid);
		if (!tt || !tc) continue;
		dWins.push(tt.wins - tc.wins);
		// A tanking team that somehow made the playoffs would leave the lottery
		// pool entirely, which would make the pick comparison meaningless.
		if (tt.playoffRoundsWon >= 0 || tc.playoffRoundsWon >= 0) {
			left += 1;
			continue;
		}
		dRank.push(poolRank(tt ? st.teams : [], tid) - poolRank(sc.teams, tid));
		dReal.push(tc.draftPick - tt.draftPick);
		const et = expectedPick(st.teams, tid, mech);
		const ec = expectedPick(sc.teams, tid, mech);
		if (et != null && ec != null) dExp.push(ec - et);
	}

	console.log(
		`${mech.padEnd(12)} ${String(dReal.length).padStart(2)}  ` +
			`${mean(dWins).toFixed(1).padStart(5)}     ${mean(dRank).toFixed(2).padStart(6)}       ` +
			`${String(left).padStart(3)}          ` +
			`${mean(dReal).toFixed(2).padStart(5)} +/- ${sem(dReal).toFixed(2)}    ` +
			`${mean(dExp).toFixed(3).padStart(6)} +/- ${sem(dExp).toFixed(3)}  ${ci(dExp)}` +
			(mismatched ? `   [${mismatched} unpaired]` : ""),
	);
}

console.log(
	`\nThe expected-pick column is the one to read. Waitlist COLA never looks at a record, so the only`,
);
console.log(
	`way a tank can move its expected pick at all is by changing WHO ELSE is in the lottery pool, and`,
);
console.log(
	`that channel is available to a manipulator under any of the three mechanisms. The record-based`,
);
console.log(
	`mechanisms carry that channel plus the direct one, which is the difference the column shows.\n`,
);
