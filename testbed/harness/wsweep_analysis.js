#!/usr/bin/env node
/**
 * Lottery-weighting (W) sweep analysis.
 *
 * Scores each weighting mechanism on the Core-outcome legs the testbed defines:
 *   (a) anti-tanking  -> worst-vs-fifth-worst expected-pick gap (lower = better;
 *                        ~0 means losing one more game buys no draft advantage).
 *   (b) equity        -> two views of whether weak teams rebuild:
 *                        - drought tail: p90 of "years since last conference
 *                          final" across team-seasons (lower = more teams
 *                          contend on a human timescale);
 *                        - recovery rate: among team-seasons in a >=3-year CF
 *                          drought, the share that reach the CF within the next
 *                          3 seasons (higher = droughted teams climb back).
 * Manipulation (leg c) is measured separately by a simulated manipulator.
 *
 * Each config is one output file ([{ seed, seasonLog }, ...]); metrics are
 * computed per replicate and aggregated as mean +/- SEM across replicates, so
 * within-league correlation does not inflate significance. The uniform-random
 * arm is the baseline leg (b) compares against.
 *
 * Usage: node wsweep_analysis.js label1=file1.json label2=file2.json ...
 */

const fs = require("fs");
const { rankOneToFiveSpread } = require("./objectives.js");

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => (a.length < 2 ? NaN : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const sem = (a) => sd(a) / Math.sqrt(a.length);
function pctile(arr, p) {
	if (!arr.length) return NaN;
	const s = arr.slice().sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
	return s[i];
}
const agg = (vals) => {
	const v = vals.filter((x) => Number.isFinite(x));
	return { mean: v.length ? mean(v) : NaN, sem: v.length > 1 ? sem(v) : NaN, n: v.length };
};
const fmt = (a, d = 2) => (Number.isFinite(a.mean) ? `${a.mean.toFixed(d)}${Number.isFinite(a.sem) ? " +/- " + a.sem.toFixed(d) : ""}` : "n/a");

// --- per-replicate metrics --------------------------------------------------

// "years since last CF" walked per team across the league, and the >=3yr-drought
// recovery indicator (reaches CF within 3 seasons).
function droughtAndRecovery(seasonLog) {
	const byTid = {};
	seasonLog.forEach((entry, t) => {
		for (const team of entry.teams) (byTid[team.tid] ??= [])[t] = team.playoffRoundsWon >= 2;
	});
	const droughts = []; // years since last CF at each team-season
	let recoNum = 0, recoDen = 0;
	for (const tid of Object.keys(byTid)) {
		const cf = byTid[tid];
		let since = 0; // seasons since last CF (counts up while out)
		for (let t = 0; t < cf.length; t++) {
			droughts.push(since);
			// recovery: if currently in a >=3yr drought, did the team reach CF in t+1..t+3?
			if (since >= 3) {
				let reached = 0, have = 0;
				for (let k = 1; k <= 3; k++) if (cf[t + k] !== undefined) { have++; if (cf[t + k]) reached = 1; }
				if (have === 3) { recoDen++; recoNum += reached; }
			}
			since = cf[t] ? 0 : since + 1;
		}
	}
	return {
		droughtP90: pctile(droughts, 90),
		droughtP75: pctile(droughts, 75),
		recoveryRate: recoDen ? recoNum / recoDen : NaN,
	};
}

function repMetrics(seasonLog) {
	const dr = droughtAndRecovery(seasonLog);
	return {
		antiTankGap: rankOneToFiveSpread(seasonLog).spread1To5,
		droughtP90: dr.droughtP90,
		droughtP75: dr.droughtP75,
		recoveryRate: dr.recoveryRate,
	};
}

// --- main -------------------------------------------------------------------

const specs = process.argv.slice(2).map((a) => {
	const eq = a.indexOf("=");
	return { label: a.slice(0, eq), file: a.slice(eq + 1) };
});
if (!specs.length) { console.error("usage: node wsweep_analysis.js label=file.json ..."); process.exit(1); }

const rows = [];
for (const { label, file } of specs) {
	let data;
	try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (e) { console.warn(`WARN skip ${label} (${file}): ${e.message}`); continue; }
	const per = data.map((r) => repMetrics(r.seasonLog));
	rows.push({
		label,
		nReps: data.length,
		nSeasons: data[0] ? data[0].seasonLog.length : 0,
		antiTank: agg(per.map((m) => m.antiTankGap)),
		p90: agg(per.map((m) => m.droughtP90)),
		recovery: agg(per.map((m) => m.recoveryRate)),
	});
}

console.log(`\n===== W-SWEEP: weighting mechanisms vs the Core-outcome legs =====\n`);
console.log(`config            reps  seas  | tanking gradient (a)  drought p90 (b)   recovery rate (b)`);
console.log(`   (tanking gradient = single-season worst-vs-fifth-worst expected-pick gap; want ~0. Help-by-drought: see help_gradient.js)`);
console.log(`${"-".repeat(92)}`);
const base = rows.find((r) => /uniform|random|baseline/i.test(r.label));
for (const r of rows) {
	const recoDelta = base && base !== r && Number.isFinite(base.recovery.mean) && Number.isFinite(r.recovery.mean)
		? ` (${r.recovery.mean - base.recovery.mean >= 0 ? "+" : ""}${(r.recovery.mean - base.recovery.mean).toFixed(3)} vs base)` : "";
	console.log(
		`${r.label.padEnd(17)} ${String(r.nReps).padStart(3)}  ${String(r.nSeasons).padStart(4)}  | ` +
		`${fmt(r.antiTank, 3).padEnd(18)} ${fmt(r.p90, 2).padEnd(16)} ${fmt(r.recovery, 3)}${recoDelta}`
	);
}
console.log(`\nLeg (a): tanking gradient near 0 = more tanking-resistant (a positive value means losing more buys a better pick).`);
console.log(`Leg (b): lower p90 and higher recovery = weak teams rebuild; compare recovery to the uniform baseline.`);
if (base) console.log(`Baseline = "${base.label}".`);
console.log("");
