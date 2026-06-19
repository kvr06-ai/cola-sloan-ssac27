#!/usr/bin/env node
/**
 * Pool-manipulation analysis (Core-outcome leg c).
 *
 * Theorem 1 (manipulation-bound paper) bounds the pool-swap gain at ~4%: a team
 * loses to a high-index opponent near the playoff boundary to push it INTO the
 * playoffs, shrinking the lottery pool by Delta = L_h - L_ell, gaining
 *   G_i = L_i * Delta / (P * (P - Delta)).
 * The bound rests on STRUCTURAL ANTI-CORRELATION: the highest-index (longest
 * drought) teams sit far from the playoff boundary, so the swappable Delta is
 * small. This script measures the realized gain and tests that assumption in the
 * full engine, using the pre-draw index L_i = colaPre.
 *
 * Two framings (the engine's COLA pool differs from the paper's):
 *   n=14 (paper): pool = the 14 non-playoff teams; boundary swap = 9th seed
 *        (best non-playoff) pushed into the playoffs, displacing the 8th seed.
 *        This is what Theorem 1's 4% is derived for, and the more manipulable.
 *   n=22 (engine's Classic/weighted pool): pool = teams that did not WIN a
 *        playoff round (non-playoff + round-1 losers). Exiting requires winning
 *        a round, so the boundary is the R1-win line; strictly harder to game.
 *
 * Usage: node manip_analysis.js label=file.json ...
 */

const fs = require("fs");

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => (a.length < 2 ? NaN : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
function pctile(a, p) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function pearson(xs, ys) {
	const n = xs.length; if (n < 2) return NaN;
	const mx = mean(xs), my = mean(ys);
	let sxy = 0, sxx = 0, syy = 0;
	for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
	return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}
const gain = (Li, P, Delta) => (Delta > 0 && P - Delta > 0 ? (Li * Delta) / (P * (P - Delta)) : 0);

// One season -> { g14, g22, antiCorr, boundaryIdxRatio }
function seasonManip(teams) {
	const L = (t) => t.colaPre ?? t.cola ?? 0;
	const byConf = { 0: [], 1: [] };
	for (const t of teams) (byConf[t.conf === "E" ? 0 : 1] ??= []).push(t);

	// --- n=14 framing: 9th-seed (best non-playoff) pushed in, 8th-seed out ---
	const nonPlayoff14 = teams.filter((t) => t.playoffRoundsWon === -1);
	const P14 = nonPlayoff14.reduce((s, t) => s + L(t), 0);
	const Lmax14 = Math.max(...nonPlayoff14.map(L));
	let g14 = 0;
	for (const conf of [0, 1]) {
		const cTeams = teams.filter((t) => (t.conf === "E" ? 0 : 1) === conf);
		const cNon = cTeams.filter((t) => t.playoffRoundsWon === -1).sort((a, b) => b.wins - a.wins);
		const cPlay = cTeams.filter((t) => t.playoffRoundsWon >= 0).sort((a, b) => a.wins - b.wins);
		if (!cNon.length || !cPlay.length) continue;
		const h = cNon[0], ell = cPlay[0]; // 9th seed in, 8th seed out
		const Delta = L(h) - L(ell);
		g14 = Math.max(g14, gain(Lmax14, P14, Delta));
	}

	// --- n=22 framing: R1-loss boundary (R1 loser pushed to win, R1 winner out) ---
	const pool22 = teams.filter((t) => t.playoffRoundsWon <= 0);
	const P22 = pool22.reduce((s, t) => s + L(t), 0);
	const Lmax22 = Math.max(...pool22.map(L));
	const r1losers = teams.filter((t) => t.playoffRoundsWon === 0);
	const r1winners = teams.filter((t) => t.playoffRoundsWon === 1);
	let g22 = 0;
	if (r1losers.length && r1winners.length) {
		const h = Math.max(...r1losers.map(L));       // high-index team to push OUT (wins R1)
		const ell = Math.min(...r1winners.map(L));    // low-index team dropping IN
		g22 = gain(Lmax22, P22, h - ell);
	}

	// --- anti-correlation diagnostics (within the 14-pool) ---
	const antiCorr = pearson(nonPlayoff14.map((t) => t.wins), nonPlayoff14.map(L));
	// index of the boundary team (best-record non-playoff) vs the pool max
	const boundary = nonPlayoff14.slice().sort((a, b) => b.wins - a.wins)[0];
	const boundaryIdxRatio = boundary && Lmax14 > 0 ? L(boundary) / Lmax14 : NaN;

	return { g14, g22, antiCorr, boundaryIdxRatio };
}

const specs = process.argv.slice(2).map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), file: a.slice(i + 1) }; });
if (!specs.length) { console.error("usage: node manip_analysis.js label=file.json ..."); process.exit(1); }

console.log(`\n===== POOL-MANIPULATION (leg c): realized gain vs the ~4% Theorem-1 bound =====\n`);
console.log(`config       | max gain n14    p95 n14   | max gain n22    p95 n22  | anti-corr(wins,idx)  boundary/maxidx`);
console.log("-".repeat(108));
for (const { label, file } of specs) {
	let data;
	try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.warn(`skip ${label}: ${e.message}`); continue; }
	if (!data[0] || data[0].seasonLog[0]?.teams[0]?.colaPre === undefined) {
		console.warn(`skip ${label}: no colaPre (re-run with the instrumented driver)`); continue;
	}
	const g14 = [], g22 = [], ac = [], bir = [];
	for (const rep of data) for (const e of rep.seasonLog) {
		const m = seasonManip(e.teams);
		g14.push(m.g14); g22.push(m.g22);
		if (Number.isFinite(m.antiCorr)) ac.push(m.antiCorr);
		if (Number.isFinite(m.boundaryIdxRatio)) bir.push(m.boundaryIdxRatio);
	}
	const pct = (x) => (x * 100).toFixed(2) + "%";
	console.log(
		`${label.padEnd(12)} | ${pct(Math.max(...g14)).padEnd(14)} ${pct(pctile(g14, 95)).padEnd(8)} | ` +
		`${pct(Math.max(...g22)).padEnd(14)} ${pct(pctile(g22, 95)).padEnd(8)} | ${mean(ac).toFixed(2).padStart(14)}     ${mean(bir).toFixed(2)}`
	);
}
console.log(`\nGain = realized pool-swap advantage in pick-1 probability. Compare max to the ~4% bound.`);
console.log(`anti-corr < 0 and boundary/maxidx << 1 mean high-index teams sit far from the boundary (the bound's premise holds).`);
console.log(`n14 = paper's non-playoff pool (more manipulable); n22 = the engine's actual COLA pool (harder to exit).\n`);
