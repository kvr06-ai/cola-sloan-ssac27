#!/usr/bin/env node
/**
 * Draft-to-outcome channel probe analysis.
 *
 * Consumes the driver's `random`-variant output ([{ seed, seasonLog }, ...],
 * where each season's teams carry { tid, wins, playoffRoundsWon, draftPick,
 * rosterOvr }) and estimates the CAUSAL effect of a team's draft pick on its
 * future outcomes.
 *
 * Identification: under the `random` variant the round-1 pick order is a uniform
 * random permutation drawn BEFORE any trades, so a team's assigned pick is
 * orthogonal to its quality. The assigned-pick -> future-outcome slope is
 * therefore the intent-to-treat causal effect of pick position (trades fold in
 * as the team's optimal response). A live channel shows a clearly NEGATIVE slope
 * (a lower pick number, i.e. an earlier pick, raises future roster ovr / wins /
 * playoff depth). A slope near zero means the draft barely moves team outcomes
 * in this headless, spectator-mode setup -- the dead-channel worry.
 *
 * Uncertainty is taken at the REPLICATE level: each replicate is an independent
 * league, so per-replicate estimates are averaged and the SEM comes from their
 * spread (no within-league pseudo-replication).
 *
 * Usage: node channel_probe.js <output.json> [--lag N]
 */

const fs = require("fs");

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function sd(a) {
	if (a.length < 2) return NaN;
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function sem(a) { return sd(a) / Math.sqrt(a.length); }

function ols(xs, ys) {
	const n = xs.length;
	if (n < 2) return { slope: NaN, r: NaN, n };
	const mx = mean(xs), my = mean(ys);
	let sxy = 0, sxx = 0, syy = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - mx, dy = ys[i] - my;
		sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
	}
	if (sxx === 0) return { slope: NaN, r: NaN, n };
	return { slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), n };
}

// --- panel construction -----------------------------------------------------

// Build, per replicate, a tid -> ordered season array. Season index is the
// position in seasonLog (chronological), not the calendar year.
function buildPanel(data) {
	return data.map((rep) => {
		const byTid = {};
		rep.seasonLog.forEach((entry, t) => {
			for (const team of entry.teams) {
				(byTid[team.tid] ??= [])[t] = team;
			}
		});
		return { seed: rep.seed, nSeasons: rep.seasonLog.length, byTid };
	});
}

// Validity: each season's round-1 picks should be a 1..N permutation, and
// rosterOvr should be populated and plausible.
function validate(data) {
	const issues = [];
	let ovrMin = Infinity, ovrMax = -Infinity, ovrZero = 0, ovrCount = 0;
	for (const rep of data) {
		rep.seasonLog.forEach((entry, t) => {
			const picks = entry.teams.map((x) => x.draftPick).filter((p) => p != null).sort((a, b) => a - b);
			const n = picks.length;
			const expected = Array.from({ length: n }, (_, i) => i + 1);
			if (JSON.stringify(picks) !== JSON.stringify(expected)) {
				issues.push(`seed ${rep.seed} season ${t}: picks not a 1..${n} permutation (got ${picks.slice(0, 5)}...)`);
			}
			for (const team of entry.teams) {
				const o = team.rosterOvr;
				if (typeof o !== "number") { issues.push(`seed ${rep.seed} s${t} tid ${team.tid}: rosterOvr missing`); continue; }
				ovrCount++;
				if (o === 0) ovrZero++;
				ovrMin = Math.min(ovrMin, o); ovrMax = Math.max(ovrMax, o);
			}
		});
	}
	return { issues, ovrMin, ovrMax, ovrZero, ovrCount };
}

// --- per-replicate estimates ------------------------------------------------

// For one replicate, collect (pick_t, outcome_{t+lag}) pairs and the
// contemporaneous (pick_t, outcome_t) pairs (orthogonality sanity).
function repEstimates(rep, lag) {
	// Per-season weak threshold: a team is "weak" at t if its wins_t fall in the
	// bottom third that season. wins_t is a pre-assignment baseline (the pick is
	// drawn after season t), so conditioning on it is legitimate and isolates the
	// policy-relevant channel: does a high pick help the WEAK teams the mechanism
	// targets, as opposed to contenders who cannot use it?
	const weakThresh = {};
	const winsByT = {};
	for (const tid of Object.keys(rep.byTid)) {
		rep.byTid[tid].forEach((rec, t) => { if (rec) (winsByT[t] ??= []).push(rec.wins); });
	}
	for (const t of Object.keys(winsByT)) {
		const sorted = winsByT[t].slice().sort((a, b) => a - b);
		weakThresh[t] = sorted[Math.floor(sorted.length / 3)]; // ~33rd percentile
	}

	const all = { pick: [], ovrNext: [], winsNext: [], ovrNow: [], winsNow: [] };
	const weak = { pick: [], ovrNext: [], winsNext: [] };
	const pickForCF = [], cfNext = [], pickCFw = [], cfNextW = [];
	for (const tid of Object.keys(rep.byTid)) {
		const series = rep.byTid[tid];
		for (let t = 0; t < series.length; t++) {
			const cur = series[t];
			if (!cur || cur.draftPick == null) continue;
			const isWeak = cur.wins <= weakThresh[t];
			const fut = series[t + lag];
			if (fut) {
				all.pick.push(cur.draftPick); all.ovrNext.push(fut.rosterOvr); all.winsNext.push(fut.wins);
				all.ovrNow.push(cur.rosterOvr); all.winsNow.push(cur.wins);
				if (isWeak) { weak.pick.push(cur.draftPick); weak.ovrNext.push(fut.rosterOvr); weak.winsNext.push(fut.wins); }
			}
			// reached the conference finals (pRW>=2) in any of the next `lag` seasons
			let reached = 0, have = 0;
			for (let k = 1; k <= lag; k++) {
				const f = series[t + k];
				if (f) { have++; if (f.playoffRoundsWon >= 2) reached = 1; }
			}
			if (have === lag) {
				pickForCF.push(cur.draftPick); cfNext.push(reached);
				if (isWeak) { pickCFw.push(cur.draftPick); cfNextW.push(reached); }
			}
		}
	}
	const TOP = 3, BOT = 20;
	const contrast = (xs, ys) => {
		const top = ys.filter((_, i) => xs[i] <= TOP);
		const bot = ys.filter((_, i) => xs[i] >= BOT);
		return (top.length && bot.length) ? mean(top) - mean(bot) : NaN;
	};
	const cfRate = (picks, cf, pred) => {
		const v = cf.filter((_, i) => pred(picks[i]));
		return v.length ? mean(v) : NaN;
	};
	return {
		ovrSlope: ols(all.pick, all.ovrNext).slope,
		winsSlope: ols(all.pick, all.winsNext).slope,
		ovrSlopeNow: ols(all.pick, all.ovrNow).slope,   // orthogonality sanity ~ 0
		winsSlopeNow: ols(all.pick, all.winsNow).slope, // orthogonality sanity ~ 0
		ovrContrast: contrast(all.pick, all.ovrNext),   // top3 minus bottom (expect > 0)
		winsContrast: contrast(all.pick, all.winsNext), // top3 minus bottom (expect > 0)
		weakWinsSlope: ols(weak.pick, weak.winsNext).slope,
		weakOvrSlope: ols(weak.pick, weak.ovrNext).slope,
		weakWinsContrast: contrast(weak.pick, weak.winsNext),
		cfTop: cfRate(pickForCF, cfNext, (p) => p <= TOP),
		cfBot: cfRate(pickForCF, cfNext, (p) => p >= BOT),
		cfTopWeak: cfRate(pickCFw, cfNextW, (p) => p <= TOP),
		cfBotWeak: cfRate(pickCFw, cfNextW, (p) => p >= BOT),
		nPairs: all.pick.length,
		nWeak: weak.pick.length,
	};
}

function agg(vals) {
	const v = vals.filter((x) => Number.isFinite(x));
	return { mean: v.length ? mean(v) : NaN, sem: v.length > 1 ? sem(v) : NaN, n: v.length };
}
function fmt(a, d = 3) {
	if (!Number.isFinite(a.mean)) return "n/a";
	const s = Number.isFinite(a.sem) ? ` ± ${a.sem.toFixed(d)}` : "";
	return `${a.mean.toFixed(d)}${s}  (n=${a.n})`;
}

// --- bucketed dose-response (pooled across replicates) ----------------------

function buckets(panel, lag) {
	const edges = [[1, 3], [4, 7], [8, 14], [15, 22], [23, 30]];
	const rows = edges.map(([lo, hi]) => ({ lo, hi, ovr: [], wins: [] }));
	for (const rep of panel) {
		for (const tid of Object.keys(rep.byTid)) {
			const series = rep.byTid[tid];
			for (let t = 0; t < series.length; t++) {
				const cur = series[t], fut = series[t + lag];
				if (!cur || cur.draftPick == null || !fut) continue;
				const row = rows.find((r) => cur.draftPick >= r.lo && cur.draftPick <= r.hi);
				if (row) { row.ovr.push(fut.rosterOvr); row.wins.push(fut.wins); }
			}
		}
	}
	return rows.map((r) => ({
		bucket: `${r.lo}-${r.hi}`,
		nextOvr: r.ovr.length ? mean(r.ovr) : NaN,
		nextWins: r.wins.length ? mean(r.wins) : NaN,
		n: r.ovr.length,
	}));
}

// --- main -------------------------------------------------------------------

const argv = process.argv.slice(2);
const lagArg = argv.indexOf("--lag");
const LAG = lagArg > -1 ? parseInt(argv[lagArg + 1], 10) : 1;
const paths = argv.filter((a, i) => a !== "--lag" && argv[i - 1] !== "--lag" && !a.startsWith("--"));
const files = paths.length ? paths : ["/tmp/probe_smoke.json"];

// Concatenate replicates across all supplied output files (parallel run chunks).
// Skip any chunk that failed to write a parseable file, so a partial run still
// analyzes the chunks that succeeded.
const data = files.flatMap((f) => {
	try { return JSON.parse(fs.readFileSync(f, "utf8")); }
	catch (e) { console.warn(`WARN: skipping ${f}: ${e.message}`); return []; }
});
if (!data.length) { console.error("No usable replicates found."); process.exit(1); }
const panel = buildPanel(data);
const v = validate(data);

console.log(`\n===== DRAFT-TO-OUTCOME CHANNEL PROBE =====`);
console.log(`files: ${files.length} (${files.map((f) => f.split("/").pop()).join(", ")})`);
console.log(`replicates: ${data.length}   seasons/replicate: ${panel.map((p) => p.nSeasons).join(",")}   lag: ${LAG}`);
console.log(`\n--- validity ---`);
console.log(`picks form 1..N permutation each season: ${v.issues.length === 0 ? "YES" : "NO (" + v.issues.length + " issues)"}`);
if (v.issues.length) console.log(v.issues.slice(0, 6).map((s) => "  " + s).join("\n"));
console.log(`rosterOvr: range ${v.ovrMin}..${v.ovrMax}, zeros ${v.ovrZero}/${v.ovrCount}`);

const est = panel.map((rep) => repEstimates(rep, LAG));
const A = (k) => agg(est.map((e) => e[k]));

console.log(`\n--- orthogonality sanity (should be ~0: assigned pick is independent of the season just played) ---`);
console.log(`slope rosterOvr_t   on pick_t : ${fmt(A("ovrSlopeNow"))}`);
console.log(`slope wins_t        on pick_t : ${fmt(A("winsSlopeNow"))}`);

console.log(`\n--- CAUSAL channel (assigned pick -> future outcome; NEGATIVE slope = live channel) ---`);
const ovrS = A("ovrSlope"), winsS = A("winsSlope");
console.log(`slope rosterOvr_{t+${LAG}} on pick_t : ${fmt(ovrS)}   [pick1 vs pick30 = ${Number.isFinite(ovrS.mean) ? (-29 * ovrS.mean).toFixed(2) : "n/a"} ovr]`);
console.log(`slope wins_{t+${LAG}}      on pick_t : ${fmt(winsS)}   [pick1 vs pick30 = ${Number.isFinite(winsS.mean) ? (-29 * winsS.mean).toFixed(2) : "n/a"} wins]`);
console.log(`top-3 minus bottom contrast, rosterOvr_{t+${LAG}} : ${fmt(A("ovrContrast"))}`);
console.log(`top-3 minus bottom contrast, wins_{t+${LAG}}      : ${fmt(A("winsContrast"))}`);

console.log(`\n--- WEAK teams only (bottom-third wins at assignment; the policy-relevant channel) ---`);
const wWinsS = A("weakWinsSlope"), wOvrS = A("weakOvrSlope");
console.log(`slope wins_{t+${LAG}}      on pick_t : ${fmt(wWinsS)}   [pick1 vs pick30 = ${Number.isFinite(wWinsS.mean) ? (-29 * wWinsS.mean).toFixed(2) : "n/a"} wins]`);
console.log(`slope rosterOvr_{t+${LAG}} on pick_t : ${fmt(wOvrS)}   [pick1 vs pick30 = ${Number.isFinite(wOvrS.mean) ? (-29 * wOvrS.mean).toFixed(2) : "n/a"} ovr]`);
console.log(`top-3 minus bottom contrast, wins_{t+${LAG}}      : ${fmt(A("weakWinsContrast"))}`);

console.log(`\n--- playoff depth: P(reach conf finals within next ${LAG}) ---`);
console.log(`all teams    : top-3 ${fmt(A("cfTop"))}  vs bottom ${fmt(A("cfBot"))}`);
console.log(`weak teams   : top-3 ${fmt(A("cfTopWeak"))}  vs bottom ${fmt(A("cfBotWeak"))}`);

console.log(`\n--- pooled dose-response (outcome at t+${LAG} by pick bucket) ---`);
console.log(`bucket   nextOvr   nextWins   n`);
for (const b of buckets(panel, LAG)) {
	console.log(`${b.bucket.padEnd(8)} ${Number.isFinite(b.nextOvr) ? b.nextOvr.toFixed(2) : "n/a"}     ${Number.isFinite(b.nextWins) ? b.nextWins.toFixed(2) : "n/a"}     ${b.n}`);
}
console.log(`\n(total assigned-pick->t+${LAG} pairs: ${est.reduce((s, e) => s + e.nPairs, 0)})\n`);
