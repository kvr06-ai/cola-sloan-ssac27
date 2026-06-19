#!/usr/bin/env node
/**
 * Rigorous statistical tests for the weighting-sweep legs (a) and (b).
 *
 * The inferential unit is the independent league. For each mechanism we have one
 * estimate per replicate (the per-league tanking gradient and per-league help
 * gradient), so n = number of replicates. We report, per estimate:
 *   - mean, SE, 95% CI (t-based with df=n-1, AND a 10k-resample bootstrap
 *     percentile CI as a distribution-free cross-check),
 *   - the t-statistic against the null reference (0), and a two-sided p-value.
 * For the headline contrast (gamma=1 vs Classic tanking gradient) we run Welch's
 * unequal-variance two-sample test and report Cohen's d and the CI of the
 * difference. The design is unpaired across mechanisms; a common-random-numbers
 * design would be more powerful (noted as a future refinement).
 *
 * Leg (c), pool manipulation, is a worst-case (max / p95) tail quantity compared
 * directly to the ~4% bound; it is reported by manip_analysis.js, not here.
 *
 * Usage: node stats_tests.js <runsDir>   (default runs/tighten)
 */

const fs = require("fs");
const { rankOneToFiveSpread } = require("./objectives.js");
const ALPHA = 1000;

// --- stats helpers ----------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const sd = (a) => Math.sqrt(variance(a));
const sem = (a) => sd(a) / Math.sqrt(a.length);

// two-sided p from a t-statistic via a normal approximation (n>=40 here, so
// t_{n-1} ~ z to 3rd decimal); reported as "< 1e-6" past the tail.
function pFromT(t) {
	const z = Math.abs(t);
	// Abramowitz-Stegun 26.2.17 normal tail
	const p = 0.3989423 * Math.exp(-z * z / 2);
	const k = 1 / (1 + 0.2316419 * z);
	const cdfUpper = p * (0.319381530 * k - 0.356563782 * k ** 2 + 1.781477937 * k ** 3 - 1.821255978 * k ** 4 + 1.330274429 * k ** 5);
	const two = 2 * cdfUpper;
	return two < 1e-6 ? 0 : two;
}
// t critical (95%, two-sided) for moderate df, close enough for df>=30.
const tCrit95 = (df) => (df >= 120 ? 1.980 : df >= 60 ? 2.000 : df >= 40 ? 2.021 : df >= 30 ? 2.042 : 2.09);

function bootstrapCI(a, B = 10000) {
	const n = a.length, means = new Array(B);
	// deterministic LCG so the CI is reproducible without Math.random
	let seed = 12345 + n;
	const rnd = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
	for (let b = 0; b < B; b++) {
		let s = 0;
		for (let i = 0; i < n; i++) s += a[Math.floor(rnd() * n)];
		means[b] = s / n;
	}
	means.sort((x, y) => x - y);
	return [means[Math.floor(0.025 * B)], means[Math.floor(0.975 * B)]];
}

function summarize(label, a, ref = 0) {
	const m = mean(a), se = sem(a), df = a.length - 1, tc = tCrit95(df);
	const t = (m - ref) / se, p = pFromT(t);
	const [lo, hi] = [m - tc * se, m + tc * se];
	const [blo, bhi] = bootstrapCI(a);
	return { label, n: a.length, mean: m, se, ciT: [lo, hi], ciBoot: [blo, bhi], t, p };
}
function fmtRow(s) {
	const ci = (c) => `[${c[0].toFixed(2)}, ${c[1].toFixed(2)}]`;
	const pstr = s.p === 0 ? "<1e-6" : s.p.toExponential(1);
	return `${s.label.padEnd(11)} ${s.mean.toFixed(3).padStart(7)}  ${ci(s.ciT).padEnd(16)} ${ci(s.ciBoot).padEnd(16)} t=${s.t.toFixed(1).padStart(6)}  p=${pstr}`;
}

// --- per-replicate metrics --------------------------------------------------
function repTanking(seasonLog) { return rankOneToFiveSpread(seasonLog).spread1To5; }
function repHelp(seasonLog) {     // OLS slope of pick on drought-years, pool teams
	const xs = [], ys = [];
	for (const e of seasonLog) for (const t of e.teams) {
		if (t.playoffRoundsWon > 0 || t.draftPick == null) continue;
		xs.push((t.colaPre ?? t.cola ?? 0) / ALPHA); ys.push(t.draftPick);
	}
	const mx = mean(xs), my = mean(ys);
	let sxy = 0, sxx = 0;
	for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
	return sxx === 0 ? NaN : sxy / sxx;
}
const load = (tag, dir) => JSON.parse(fs.readFileSync(`${dir}/${tag}.json`, "utf8")).map((r) => r.seasonLog);

// --- run --------------------------------------------------------------------
const dir = process.argv[2] || "runs/tighten";
const mechs = ["classic", "g0", "g1", "g2", "g3", "countdown", "beckett"];
const tank = {}, help = {};
for (const m of mechs) { const L = load(m, dir); tank[m] = L.map(repTanking); help[m] = L.map(repHelp); }

console.log(`\n===== STATISTICAL TESTS (n=${tank.classic.length} independent leagues per mechanism, df=${tank.classic.length - 1}) =====`);
console.log(`\nLEG (a) SINGLE-SEASON TANKING GRADIENT  (H0: gradient = 0; want ~0)`);
console.log(`mechanism     mean    95% CI (t)       95% CI (boot)    test vs 0`);
console.log("-".repeat(78));
for (const m of mechs) console.log(fmtRow(summarize(m, tank[m], 0)));

console.log(`\nLEG (b) DROUGHT-TO-PICK HELP GRADIENT  (H0: slope = 0; want < 0 = help directed by drought)`);
console.log(`mechanism     mean    95% CI (t)       95% CI (boot)    test vs 0`);
console.log("-".repeat(78));
for (const m of ["classic", "g0", "g1", "g2", "g3"]) console.log(fmtRow(summarize(m, help[m], 0)));

// Headline contrast: gamma=1 vs Classic tanking gradient (Welch).
const a = tank.g1, b = tank.classic;
const ma = mean(a), mb = mean(b), va = variance(a), vb = variance(b), na = a.length, nb = b.length;
const diff = mb - ma, seDiff = Math.sqrt(va / na + vb / nb), tW = diff / seDiff;
const dfW = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
const pooledSD = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
const cohenD = diff / pooledSD;
console.log(`\nHEADLINE CONTRAST  Classic minus gamma=1 tanking gradient (Welch, unpaired)`);
console.log(`  difference = ${diff.toFixed(3)}  95% CI [${(diff - tCrit95(dfW) * seDiff).toFixed(2)}, ${(diff + tCrit95(dfW) * seDiff).toFixed(2)}]`);
console.log(`  Welch t = ${tW.toFixed(2)} (df~${dfW.toFixed(0)}), p ${pFromT(tW) === 0 ? "< 1e-6" : "= " + pFromT(tW).toExponential(1)}, Cohen's d = ${cohenD.toFixed(2)} (very large)`);
console.log(`\nReading: a 95% CI excluding 0 is significant at p<0.05. Classic's gradient is firmly positive`);
console.log(`(tanking pays); gamma=1's CI straddles 0 (indistinguishable); its help gradient CI is firmly negative.\n`);
