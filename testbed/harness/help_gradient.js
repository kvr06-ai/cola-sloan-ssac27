#!/usr/bin/env node
/**
 * Drought-to-pick "help" gradient (the affirmative complement to the
 * single-season tanking gradient).
 *
 * Question: within the lottery pool, does a longer-drought team draft better
 * than a briefly-bad one? This is what "the mechanism directs help to the worst
 * teams" actually means under COLA: priority by MULTI-YEAR drought, not by
 * single-season record. It is the gradient we WANT positive, and it is distinct
 * from the worst-vs-fifth-worst single-season gap (which we want flat).
 *
 * Drought is the pre-draw multi-year index (colaPre); since a non-playoff season
 * adds COLA_ALPHA = 1000, colaPre / 1000 is approximately the accumulated
 * drought in years. Restricted to the pool (teams that did not win a playoff
 * round), so the all-vs-nothing pool/non-pool split does not dominate.
 *
 * NOTE (2026-06-24): the prw <= 0 filter below equals the lottery pool only in
 * the E=22 runs. In E=14 runs it also sweeps in the 8 first-round losers (picks
 * 15+, near-zero post-diminishment drought), inflating every slope; for E=14
 * use e14_analysis.js (prw < 0).
 *
 * A clearly NEGATIVE slope (more drought -> lower pick number -> earlier pick)
 * is the mechanism directing help to the long-suffering.
 *
 * Usage: node help_gradient.js label=file.json ...  (files need colaPre)
 */

const fs = require("fs");
const ALPHA = 1000;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => (a.length < 2 ? NaN : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const sem = (a) => sd(a) / Math.sqrt(a.length);
function ols(xs, ys) {
	const n = xs.length; if (n < 2) return NaN;
	const mx = mean(xs), my = mean(ys);
	let sxy = 0, sxx = 0;
	for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
	return sxx === 0 ? NaN : sxy / sxx;
}
const agg = (v) => { const f = v.filter(Number.isFinite); return { mean: mean(f), sem: f.length > 1 ? sem(f) : NaN, n: f.length }; };
const fmt = (a, d = 2) => (Number.isFinite(a.mean) ? `${a.mean.toFixed(d)}${Number.isFinite(a.sem) ? " +/- " + a.sem.toFixed(d) : ""}` : "n/a");

// Per replicate: slope of pick on drought-years among pool teams, plus mean pick
// in three drought buckets.
function repGradient(seasonLog) {
	const droughtYrs = [], picks = [];
	for (const e of seasonLog) for (const t of e.teams) {
		if (t.playoffRoundsWon > 0) continue;            // pool only
		if (t.draftPick == null) continue;
		const idx = t.colaPre ?? t.cola ?? 0;
		droughtYrs.push(idx / ALPHA);
		picks.push(t.draftPick);
	}
	const bucket = (lo, hi) => {
		const ps = picks.filter((_, i) => droughtYrs[i] >= lo && droughtYrs[i] < hi);
		return ps.length ? mean(ps) : NaN;
	};
	return {
		slope: ols(droughtYrs, picks),       // picks per drought-year (negative = help)
		b1: bucket(0, 2), b2: bucket(2, 5), b3: bucket(5, Infinity),
	};
}

const specs = process.argv.slice(2).map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), file: a.slice(i + 1) }; });
if (!specs.length) { console.error("usage: node help_gradient.js label=file.json ..."); process.exit(1); }

console.log(`\n===== DROUGHT-TO-PICK "HELP" GRADIENT (pool teams; drought = pre-draw index / 1000 ~ years) =====\n`);
console.log(`mechanism    | pick per drought-yr (neg = help) | mean pick by drought: 1-2y   3-5y    6y+`);
console.log("-".repeat(96));
for (const { label, file } of specs) {
	let data;
	try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.warn(`skip ${label}: ${e.message}`); continue; }
	if (data[0]?.seasonLog[0]?.teams[0]?.colaPre === undefined) { console.warn(`skip ${label}: no colaPre`); continue; }
	const per = data.map((r) => repGradient(r.seasonLog));
	const A = (k) => agg(per.map((p) => p[k]));
	const b = (k) => { const a = A(k); return Number.isFinite(a.mean) ? a.mean.toFixed(1) : "n/a"; };
	console.log(`${label.padEnd(12)} | ${fmt(A("slope"), 3).padStart(28)}     |   ${b("b1").padStart(5)}   ${b("b2").padStart(5)}   ${b("b3").padStart(5)}`);
}
console.log(`\nNegative slope = longer drought draws an earlier pick (help is directed by multi-year drought).`);
console.log(`Mean pick should DECREASE left-to-right (1-2y -> 6y+) if the mechanism rewards sustained drought.\n`);
