#!/usr/bin/env node
/**
 * The paper's master mechanism table, in one command.
 *
 * Nine mechanisms scored on the two legs the study discriminates on, all at
 * Highley's canonical eligibility (E = 14, the fourteen non-playoff teams), all
 * on 48 independent leagues of 15 seasons:
 *
 *   leg (a) tanking   rank the fourteen pool teams by the season just played and
 *                     report the gap in draft pick between the team ranked first
 *                     and the team ranked fifth. A positive value means a worse
 *                     record bought a better pick. The target is zero.
 *   leg (b) help      the SAME gap, with the same teams ranked by the mechanism's
 *                     OWN priority metric. Wide means the mechanism concentrates
 *                     its best picks on the teams it judges most deserving.
 *
 * That is the testbed specification, and it is one statistic read two ways. Its
 * force shows on the record-based mechanisms, where the two rankings are the same
 * ranking and the two columns are therefore identical by construction: such a
 * mechanism cannot separate helping the weak from rewarding losing even in
 * principle. An OLS slope of pick on drought-years is reported alongside as a
 * higher-powered but less direct estimator of the same leg (b) question.
 *
 * Leg (b)'s slope is reported twice. The full-run slope includes seasons 1 to 3, when
 * every team's carry-over index is still filling from zero and no mechanism can
 * separate teams that have not yet accumulated any history. That transient
 * attenuates the slope toward zero. The steady-state slope drops those seasons
 * and is the number a league operating the mechanism in perpetuity would see;
 * it is the one the paper reports, with the full-run figure kept alongside so
 * the effect of the choice is visible rather than buried.
 *
 * Both legs use the same fourteen-team covariate set for every mechanism (the
 * non-playoff teams), including the two 3-2-1 arms whose own pool is sixteen
 * teams selected by record. Scoring every arm over the same teams is what makes
 * the columns comparable; a mechanism is free to hand those teams later picks.
 *
 * Usage: node paper_tables.js [runsDir=runs]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { rankOneToFiveSpread } = require("./objectives.js");

const ALPHA = 1000; // engine index scale: colaPre / ALPHA ~ drought-years
const STEADY_FROM = 3; // 0-based: drop seasons 1-3, keep 4-15
const ROOT = process.argv[2] ?? "runs";

const MECHS = [
	["nba", "ref", "NBA lottery, 2019 rules", true],
	["t321a", "ref", "3-2-1, top-four draw", true],
	["t321b", "ref", "3-2-1, full-pool draw", true],
	["classic", "e14", "Classic COLA", false],
	["g0", "e14", "COLA, flat weighting", false],
	["g1", "e14", "COLA, full-depth proportional", false],
	["g2", "e14", "COLA, steep weighting", false],
	["g3", "e14", "COLA, steepest weighting", false],
	["mid", "e14", "Waitlist COLA", false],
];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a) => {
	const m = mean(a);
	return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const sem = (a) => Math.sqrt(variance(a) / a.length);
const TC = 2.01; // t_{0.975, df=47}

function ols(xs, ys) {
	const n = xs.length;
	if (n < 2) return NaN;
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
	}
	return sxx === 0 ? NaN : sxy / sxx;
}

function helpSlope(seasonLog, from = 0) {
	const d = [];
	const p = [];
	for (const e of seasonLog.slice(from)) {
		for (const t of e.teams) {
			if (t.playoffRoundsWon >= 0) continue; // the fourteen non-playoff teams
			if (t.draftPick == null) continue;
			d.push((t.colaPre ?? t.cola ?? 0) / ALPHA);
			p.push(t.draftPick);
		}
	}
	return ols(d, p);
}

/**
 * Equity at the outcome, as opposed to equity at the pick. A mechanism can aim
 * draft help perfectly and still fail to return anyone to contention, because
 * the draft is only one of the channels that decides who contends. Two readings:
 *
 *   drought tail    the 90th percentile of years since a team's last conference
 *                   final, across every team-season. Lower is better.
 *   recovery rate   among team-seasons already three or more years without a
 *                   conference final, the share reaching one within the next
 *                   three seasons. Higher is better. Observations inside three
 *                   seasons of the end of the run are dropped rather than scored
 *                   as failures, since their window is censored.
 */
function equityOutcomes(seasonLog) {
	const seasons = seasonLog.length;
	const cf = new Map(); // tid -> Set of season indices with a conference final
	seasonLog.forEach((e, s) => {
		for (const t of e.teams) {
			if (!cf.has(t.tid)) cf.set(t.tid, new Set());
			if (t.playoffRoundsWon >= 2) cf.get(t.tid).add(s);
		}
	});
	const droughts = [];
	let eligible = 0;
	let recovered = 0;
	for (const [tid, hits] of cf) {
		let last = -1;
		for (let s = 0; s < seasons; s++) {
			if (hits.has(s)) last = s;
			const since = last < 0 ? s + 1 : s - last;
			droughts.push(since);
			if (since >= 3 && s + 3 < seasons) {
				eligible += 1;
				if (hits.has(s + 1) || hits.has(s + 2) || hits.has(s + 3)) recovered += 1;
			}
		}
	}
	droughts.sort((a, b) => a - b);
	return {
		p90: droughts[Math.floor(0.9 * droughts.length)],
		recovery: eligible ? recovered / eligible : NaN,
	};
}

function welch(x, y) {
	const vx = variance(x);
	const vy = variance(y);
	const nx = x.length;
	const ny = y.length;
	const t = (mean(x) - mean(y)) / Math.sqrt(vx / nx + vy / ny);
	const df =
		(vx / nx + vy / ny) ** 2 /
		((vx / nx) ** 2 / (nx - 1) + (vy / ny) ** 2 / (ny - 1));
	const sp = Math.sqrt(((nx - 1) * vx + (ny - 1) * vy) / (nx + ny - 2));
	return { t, df, d: (mean(x) - mean(y)) / sp };
}

const fmt = (a) => {
	const lo = mean(a) - TC * sem(a);
	const hi = mean(a) + TC * sem(a);
	return (
		`${mean(a) >= 0 ? "+" : ""}${mean(a).toFixed(3)} +/- ${sem(a).toFixed(3)} ` +
		`[${lo.toFixed(2)}, ${hi.toFixed(2)}]${lo <= 0 && hi >= 0 ? "*" : " "}`
	);
};

/**
 * The testbed's two tests, which are ONE statistic read under two rankings.
 *
 * Rank the fourteen pool teams, take the team ranked first and the team ranked
 * fifth, and report the gap in the draft pick they received. Rank by the season
 * just played and the gap is the tanking reward, which should be zero. Rank by
 * the mechanism's OWN priority metric and the same gap is how hard the mechanism
 * concentrates its best picks on the teams it judges most deserving, which
 * should be wide.
 *
 * The framing earns its keep on the record-based mechanisms, where the two
 * rankings are the same ranking, so the two numbers are identical by
 * construction. A mechanism whose priority basis is a record cannot separate
 * helping the weak from rewarding losing even in principle. Only a mechanism
 * that prioritizes on something else can hold one column at zero and the other
 * wide, which is the entire argument of this paper in one table.
 */
function twoTests(seasonLog, ownIsRecord, from = STEADY_FROM) {
	const a = [];
	const b = [];
	for (const e of seasonLog.slice(from)) {
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 0 && t.draftPick != null);
		if (pool.length !== 14) continue;
		const byRecord = pool.slice().sort((x, y) => x.wins - y.wins);
		a.push(byRecord[4].draftPick - byRecord[0].draftPick);
		const byOwn = ownIsRecord
			? byRecord
			: pool.slice().sort((x, y) => (y.colaPre ?? 0) - (x.colaPre ?? 0));
		b.push(byOwn[4].draftPick - byOwn[0].draftPick);
	}
	return { a: mean(a), b: mean(b) };
}

const legA = {};
const legB = {};
const tank = {};
const help = {};
const helpSteady = {};
const p90 = {};
const recov = {};
const label = {};

for (const [key, dir, name, ownIsRecord] of MECHS) {
	const file = path.join(ROOT, dir, `${key}.json`);
	let reps;
	try {
		reps = JSON.parse(fs.readFileSync(file, "utf8")).map((r) => r.seasonLog);
	} catch (e) {
		console.error(`skip ${key}: ${e.message}`);
		continue;
	}
	label[key] = name;
	const tt = reps.map((r) => twoTests(r, ownIsRecord));
	legA[key] = tt.map((x) => x.a).filter(Number.isFinite);
	legB[key] = tt.map((x) => x.b).filter(Number.isFinite);
	tank[key] = reps.map((s) => rankOneToFiveSpread(s).spread1To5).filter(Number.isFinite);
	help[key] = reps.map((s) => helpSlope(s, 0)).filter(Number.isFinite);
	helpSteady[key] = reps.map((s) => helpSlope(s, STEADY_FROM)).filter(Number.isFinite);
	const eq = reps.map(equityOutcomes);
	p90[key] = eq.map((e) => e.p90);
	recov[key] = eq.map((e) => e.recovery).filter(Number.isFinite);
}

const present = MECHS.filter(([k]) => label[k]);

console.log(
	`\n===== Master mechanism table, E = 14, 48 leagues x 15 seasons per arm =====\n`,
);
console.log(
	`Mean +/- standard error across the 48 leagues, with the 95% interval. A star marks an interval`,
);
console.log(`that includes zero.\n`);
console.log(
	`THE TWO TESTS (testbed spec): one statistic, two rankings. Gap in draft pick between the team`,
);
console.log(
	`ranked first and the team ranked fifth, seasons 4-15. Record-based mechanisms have identical`,
);
console.log(`columns by construction, which is the point.\n`);
console.log(
	`mechanism                       (a) rank by RECORD            (b) rank by OWN metric`,
);
console.log(`                                want 0                        want wide`);
console.log("-".repeat(96));
for (const [key] of present) {
	console.log(`${label[key].padEnd(31)} ${fmt(legA[key]).padEnd(30)} ${fmt(legB[key])}`);
}

console.log(
	`\nSupporting estimators for leg (b): OLS slope of pick on drought-years among pool teams.`,
);
console.log(
	`mechanism                       slope, seasons 4-15           slope, seasons 1-15`,
);
console.log("-".repeat(96));
for (const [key] of present) {
	console.log(
		`${label[key].padEnd(31)} ${fmt(helpSteady[key]).padEnd(30)} ${mean(help[key]).toFixed(3)}`,
	);
}

// The same help gradient in plain units: where does a team actually pick, given
// how long it has been waiting? Buckets are drought-years, steady state only.
console.log(`\nMean assigned pick by length of drought (seasons 4-15, pool teams):`);
console.log(`mechanism                       1-2 yr   3-5 yr    6+ yr    gap (1-2 yr minus 6+ yr)`);
console.log("-".repeat(96));
for (const [key, dir] of present) {
	const reps = JSON.parse(fs.readFileSync(path.join(ROOT, dir, `${key}.json`), "utf8"));
	const b = [[], [], []];
	for (const r of reps) {
		for (const e of r.seasonLog.slice(STEADY_FROM)) {
			for (const t of e.teams) {
				if (t.playoffRoundsWon >= 0 || t.draftPick == null) continue;
				const d = (t.colaPre ?? 0) / ALPHA;
				const i = d < 3 ? 0 : d < 6 ? 1 : 2;
				b[i].push(t.draftPick);
			}
		}
	}
	console.log(
		`${label[key].padEnd(31)} ${b.map((x) => mean(x).toFixed(1).padStart(6)).join("   ")}` +
			`      ${(mean(b[0]) - mean(b[2])).toFixed(1).padStart(5)}`,
	);
}

console.log(`\nEquity at the outcome, where the draft is only one of several channels:`);
console.log(`mechanism                       drought tail, p90 years   recovery rate within 3 seasons`);
console.log("-".repeat(90));
for (const [key] of present) {
	console.log(
		`${label[key].padEnd(31)} ${mean(p90[key]).toFixed(2).padStart(14)}            ` +
			`${mean(recov[key]).toFixed(3).padStart(10)} +/- ${sem(recov[key]).toFixed(3)}`,
	);
}

console.log(`\nContrasts that carry the argument (Welch, unequal variance):`);
const CONTRASTS = [
	["a", "classic", "mid", "Classic COLA rewards losing, Waitlist COLA does not"],
	["a", "nba", "mid", "the status quo rewards losing, Waitlist COLA does not"],
	["b", "mid", "classic", "Waitlist concentrates help harder than Classic on its own metric"],
	["b", "mid", "g1", "Waitlist concentrates help harder than full-depth proportional"],
	["b", "mid", "g0", "a flat lottery concentrates no help at all"],
	["b-steady", "mid", "classic", "same conclusion via the OLS slope estimator"],
];
for (const [leg, x, y, why] of CONTRASTS) {
	const src = leg === "a" ? legA : leg === "b" ? legB : leg === "b-full" ? help : helpSteady;
	if (!src[x] || !src[y]) continue;
	const w = welch(src[x], src[y]);
	console.log(
		`  leg (${leg.padEnd(8)})  ${(label[x] + " vs " + label[y]).padEnd(56)} ` +
			`t=${w.t.toFixed(2).padStart(7)}  df=${w.df.toFixed(0).padStart(3)}  d=${w.d.toFixed(2).padStart(6)}   ${why}`,
	);
}

// Where the tanking gradient comes from. Two mechanisms can order the tail by
// record identically and still pay differently for losing, because a raffle that
// is itself weighted by record pulls the worst teams out of the tail and so
// promotes everyone behind them. Splitting the worst-versus-fifth-worst gap into
// the raffle share and the tail share shows which effect is doing the work.
{
	const { pickDistribution, buildPool } = require("./pick_dist.js");
	console.log(`\nWhere the tanking gradient comes from (exact, same seasons):`);
	console.log(
		`mechanism                       gap    worst: P(top 4)  fallback   5th-worst: P(top 4)  fallback`,
	);
	console.log("-".repeat(104));
	for (const [key, dir] of present) {
		if (!["nba", "classic", "mid"].includes(key)) continue;
		const reps = JSON.parse(fs.readFileSync(path.join(ROOT, dir, `${key}.json`), "utf8"));
		const mech = key === "mid" ? "waitlist" : key;
		const acc = { 1: { e: [], p: [], t: [] }, 5: { e: [], p: [], t: [] } };
		for (const r of reps) {
			for (const e of r.seasonLog) {
				const pool = e.teams.filter((t) => t.playoffRoundsWon < 0);
				if (pool.length !== 14) continue;
				const d = pickDistribution(buildPool(pool, mech), 4);
				const ranked = pool.slice().sort((a, b) => a.wins - b.wins);
				for (const rk of [1, 5]) {
					const tid = ranked[rk - 1].tid;
					const p4 = d.pPos[tid].reduce((x, y) => x + y, 0);
					const inDraw = d.pPos[tid].reduce((s, p, i) => s + p * (i + 1), 0);
					acc[rk].e.push(d.ePick[tid]);
					acc[rk].p.push(p4);
					acc[rk].t.push((d.ePick[tid] - inDraw) / (1 - p4));
				}
			}
		}
		console.log(
			`${label[key].padEnd(31)} ${(mean(acc[5].e) - mean(acc[1].e)).toFixed(2).padStart(5)}    ` +
				`${(100 * mean(acc[1].p)).toFixed(1).padStart(9)}%   ${mean(acc[1].t).toFixed(2).padStart(6)}     ` +
				`${(100 * mean(acc[5].p)).toFixed(1).padStart(12)}%   ${mean(acc[5].t).toFixed(2).padStart(6)}`,
		);
	}
	console.log(
		`  Fallback is the expected pick conditional on NOT winning a raffle slot. A record-weighted`,
	);
	console.log(
		`  raffle empties the bottom of the tail, which promotes the fifth-worst team's fallback and`,
	);
	console.log(`  shrinks the gap even though the tail rule is identical.`);
}

console.log(
	`\nThe transient the steady-state column removes: seasons 1-3 hold every index near zero, so no`,
);
console.log(
	`drought-based mechanism can separate teams that have no drought yet, and including those seasons`,
);
console.log(
	`pulls each slope toward zero. Waitlist COLA reads ${mean(helpSteady.mid).toFixed(2)} in steady state against ` +
		`${mean(help.mid).toFixed(2)} over the full run.\n`,
);
