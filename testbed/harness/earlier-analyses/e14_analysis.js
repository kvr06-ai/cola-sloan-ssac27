#!/usr/bin/env node
/**
 * E=14 two-leg analysis (Sims 1+2: canonical-eligibility rerun + middle option).
 *
 * Scores the six runs/e14 configs (classic, g0..g3, mid) on:
 *   leg (a) tanking : single-season tanking gradient (rankOneToFiveSpread.spread1To5,
 *                     rank lottery teams by THIS-SEASON wins; want ~0), plus Welch
 *                     contrasts classic-g1, classic-mid, g1-mid.
 *   leg (b) help    : per-drought-year pick slope among LOTTERY-POOL teams
 *                     (playoffRoundsWon < 0; want clearly negative).
 *
 * POOL FILTER (the load-bearing detail): at E=14 the lottery pool is exactly the
 * 14 non-playoff teams (prw < 0, picks 1-14). help_gradient.js filters prw <= 0,
 * which coincides with the pool in the E=22 runs but at E=14 additionally sweeps
 * in the 8 first-round losers (picks 15+, near-zero post-diminishment drought),
 * inflating every slope (classic reads -1.70 instead of the correct -0.93).
 * This script filters prw < 0.
 *
 * Index scale: all six configs (weighted included) carry the engine's x1000-scale
 * index; colaPre / 1000 ~ drought-years. Verified against the raw runs 2026-07-19.
 * Numbers cross-checked by clean-room recomputation (3-agent verification pass).
 *
 * Run from this directory:  node e14_analysis.js [runsDir]   (default runs/e14)
 */

const fs = require("fs");
const { rankOneToFiveSpread } = require("./objectives.js");
const ALPHA = 1000;
const dir = process.argv[2] || "runs/e14";
const mechs = ["classic", "g0", "g1", "g2", "g3", "mid"];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const sem = (a) => Math.sqrt(variance(a) / a.length);
const TC = 2.01; // t_{0.975, df=47}
const ci = (a) => [mean(a) - TC * sem(a), mean(a) + TC * sem(a)];

function ols(xs, ys) {
	const n = xs.length; if (n < 2) return NaN;
	const mx = mean(xs), my = mean(ys);
	let sxy = 0, sxx = 0;
	for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
	return sxx === 0 ? NaN : sxy / sxx;
}

// leg (b): per-replicate slope of pick on drought-years, lottery pool only.
function repHelpSlope(seasonLog) {
	const d = [], p = [];
	for (const e of seasonLog) for (const t of e.teams) {
		if (t.playoffRoundsWon >= 0) continue;          // lottery pool only (prw < 0)
		if (t.draftPick == null) continue;
		d.push((t.colaPre ?? t.cola ?? 0) / ALPHA);
		p.push(t.draftPick);
	}
	return ols(d, p);
}

function welch(x, y) {
	const vx = variance(x), vy = variance(y), nx = x.length, ny = y.length;
	const se = Math.sqrt(vx / nx + vy / ny);
	const t = (mean(x) - mean(y)) / se;
	const df = (vx / nx + vy / ny) ** 2 / ((vx / nx) ** 2 / (nx - 1) + (vy / ny) ** 2 / (ny - 1));
	const sp = Math.sqrt(((nx - 1) * vx + (ny - 1) * vy) / (nx + ny - 2));
	return { t, df, d: (mean(x) - mean(y)) / sp };
}

const load = (m) => JSON.parse(fs.readFileSync(`${dir}/${m}.json`, "utf8")).map((r) => r.seasonLog);
const fmtCI = (a) => `${mean(a).toFixed(3)} +/- ${sem(a).toFixed(3)}  CI[${ci(a)[0].toFixed(2)}, ${ci(a)[1].toFixed(2)}]${ci(a)[0] <= 0 && ci(a)[1] >= 0 ? " (incl 0)" : " (excl 0)"}`;

const tank = {}, help = {};
console.log(`E=14 two-leg analysis (${dir}); pool = the 14 non-playoff teams (prw < 0).\n`);
console.log(`config     leg (a) tanking gradient (want ~0)            leg (b) help slope, picks/drought-yr (want < 0)`);
console.log("-".repeat(110));
for (const m of mechs) {
	const L = load(m);
	tank[m] = L.map((s) => rankOneToFiveSpread(s).spread1To5).filter(Number.isFinite);
	help[m] = L.map(repHelpSlope).filter(Number.isFinite);
	console.log(`${m.padEnd(9)}  ${fmtCI(tank[m]).padEnd(44)}  ${fmtCI(help[m])}`);
}
console.log(`\nWelch contrasts, leg (a):`);
for (const [x, y] of [["classic", "g1"], ["classic", "mid"], ["g1", "mid"]]) {
	const w = welch(tank[x], tank[y]);
	console.log(`  ${(x + " - " + y).padEnd(15)} t=${w.t.toFixed(2).padStart(6)}  df=${w.df.toFixed(0)}  Cohen d=${w.d.toFixed(2)}`);
}
console.log(`\nWelch contrasts, leg (b):`);
for (const [x, y] of [["mid", "classic"], ["mid", "g1"]]) {
	const w = welch(help[x], help[y]);
	console.log(`  ${(x + " - " + y).padEnd(15)} t=${w.t.toFixed(2).padStart(6)}  df=${w.df.toFixed(0)}  Cohen d=${w.d.toFixed(2)}`);
}
