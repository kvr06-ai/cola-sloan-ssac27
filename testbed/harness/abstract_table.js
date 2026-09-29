#!/usr/bin/env node
/**
 * The SSAC27 abstract's table, one column per criterion, on the 25-season run.
 *
 * Reads runs/frontier/<tag>.json (30 leagues x 25 seasons per mechanism, shared
 * seeds) and prints, per mechanism, the league mean of:
 *   stuck      longest run of seasons any team spends with neither a playoff
 *              series win nor a top-3 pick (targeted help: the "hope" measure)
 *   stuckAvg   the same run averaged over teams
 *   maxSeries  longest drought between playoff-series wins, any team (parity,
 *              the criterion as pre-specified)
 *   never      teams never winning a series in 25 seasons
 *   avgPlayoff the average team's longest run without a playoff appearance
 *   maxPlayoff the longest run without a playoff appearance, any team
 * then the paired difference of each mechanism against the 2019 NBA lottery and
 * the adopted 3-2-1, with a 95% t interval over the 30 leagues.
 *
 * For "simplerule" (Simple COLA as the abstract words it) it also prices the
 * reward for losing exactly: take each season as it happened, drop one pool
 * team to the worst record in the pool, and re-rank under the rule (drought,
 * then most wins, then a coin flip, so tied positions count at their mean).
 * Positive = losing buys an earlier pick. The record-based and index mechanisms
 * are priced by tank_counterfactual.js.
 *
 * Usage: node abstract_table.js [runsDir=runs/frontier]
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ARGS = process.argv.slice(2);
const flagsHas = (f) => ARGS.includes(f);
const ROOT = ARGS.find((a) => !a.startsWith("--")) ?? "runs/frontier";
const MECHS = [
	["nba", "Current NBA lottery (2019 to 2026)"],
	["t321", "New NBA lottery, 3-2-1 (from 2027)"],
	["uniform", "Equal-odds lottery"],
	["classic", "Classic COLA"],
	["waitlist", "Waitlist COLA"],
	["simple", "Simple COLA, as first run (index)"],
	["simplerule", "Simple COLA, abstract rule"],
	["full", "Full-lottery COLA"],
	["countdown", "Countdown COLA"],
	["beckett", "Beckett COLA"],
];
const BASES = ["nba", "t321"];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const T29 = 2.045; // t_{0.975}, df 29

// Longest run of consecutive seasons in which stop(t) is false, per team.
function longestRuns(seasonLog, stop) {
	const now = {};
	const best = {};
	for (const e of seasonLog) {
		for (const t of e.teams) {
			if (stop(t)) now[t.tid] = 0;
			else now[t.tid] = (now[t.tid] ?? 0) + 1;
			best[t.tid] = Math.max(best[t.tid] ?? 0, now[t.tid]);
		}
	}
	return Object.values(best);
}

function perLeague(seasonLog) {
	const stuck = longestRuns(seasonLog, (t) => t.playoffRoundsWon >= 1 || (t.draftPick ?? 99) <= 3);
	const series = longestRuns(seasonLog, (t) => t.playoffRoundsWon >= 1);
	const playoff = longestRuns(seasonLog, (t) => t.playoffRoundsWon >= 0);
	return {
		stuck: Math.max(...stuck),
		stuckAvg: mean(stuck),
		maxSeries: Math.max(...series),
		never: series.filter((r) => r === seasonLog.length).length,
		avgPlayoff: mean(playoff),
		maxPlayoff: Math.max(...playoff),
	};
}

// Exact reward for losing under the simple rule, by starting rank among the 14
// non-playoff teams (rank 1 = worst record), dropping to the worst record.
function simpleRuleReward(seasonLog) {
	const drought = {};
	const byRank = {};
	for (const e of seasonLog) {
		for (const t of e.teams) {
			drought[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (drought[t.tid] ?? 0) + 1;
		}
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 1);
		const pick = (tid, wins) => {
			const me = { d: drought[tid], w: wins };
			let ahead = 0;
			let tied = 0;
			for (const o of pool) {
				if (o.tid === tid) continue;
				const d = drought[o.tid];
				if (d > me.d || (d === me.d && o.wins > me.w)) ahead++;
				else if (d === me.d && o.wins === me.w) tied++;
			}
			return 1 + ahead + tied / 2;
		};
		const lottery = e.teams.filter((t) => t.playoffRoundsWon < 0).sort((a, b) => a.wins - b.wins);
		if (lottery.length === 14) {
			const worst = lottery[0].wins;
			for (let r = 2; r <= 14; r++) {
				const t = lottery[r - 1];
				(byRank[r] ??= []).push(pick(t.tid, t.wins) - pick(t.tid, worst - 1));
			}
		}
		for (const t of e.teams) if ((t.draftPick ?? 99) <= 3) drought[t.tid] = 0;
	}
	return byRank;
}

const data = {};
const logs = {};
for (const [tag] of MECHS) {
	const file = path.join(ROOT, `${tag}.json`);
	if (!fs.existsSync(file)) {
		console.error(`skip ${tag}: ${file} not found`);
		continue;
	}
	const reps = JSON.parse(fs.readFileSync(file, "utf8"));
	data[tag] = new Map(reps.map((r) => [r.seed, perLeague(r.seasonLog)]));
	logs[tag] = reps;
}
const tags = MECHS.map(([t]) => t).filter((t) => data[t]);
const KEYS = ["stuck", "stuckAvg", "maxSeries", "never", "avgPlayoff", "maxPlayoff"];
const label = Object.fromEntries(MECHS);

console.log("\nLeague means over the 30 leagues (seasons unless noted; never = teams per league)\n");
console.log("mechanism".padEnd(38) + KEYS.map((k) => k.padStart(11)).join(""));
for (const tag of tags) {
	const v = [...data[tag].values()];
	console.log(label[tag].padEnd(38) + KEYS.map((k) => mean(v.map((x) => x[k])).toFixed(2).padStart(11)).join(""));
}

for (const base of BASES.filter((b) => data[b])) {
	console.log(`\nPaired difference vs ${label[base]}: mean [95% CI], negative = shorter / fewer\n`);
	console.log("mechanism".padEnd(38) + KEYS.map((k) => k.padStart(22)).join(""));
	for (const tag of tags) {
		if (tag === base) continue;
		const cells = KEYS.map((k) => {
			const d = [...data[tag].keys()].filter((s) => data[base].has(s)).map((s) => data[tag].get(s)[k] - data[base].get(s)[k]);
			const m = mean(d);
			const h = (T29 * sd(d)) / Math.sqrt(d.length);
			return `${m.toFixed(2)} [${(m - h).toFixed(2)}, ${(m + h).toFixed(2)}]`.padStart(22);
		});
		console.log(label[tag].padEnd(38) + cells.join(""));
	}
}

if (logs.simplerule) {
	const all = {};
	for (const rep of logs.simplerule) {
		const r = simpleRuleReward(rep.seasonLog);
		for (const [k, v] of Object.entries(r)) (all[k] ??= []).push(...v);
	}
	console.log("\nSimple rule: draft places gained by dropping to the worst record, by starting rank (1 = worst)\n");
	console.log(Object.keys(all).map((k) => `${k}:${mean(all[k]).toFixed(2)}`).join("  "));
	const h = all[5];
	console.log(`5th-worst to last: mean ${mean(h).toFixed(3)}, max ${Math.max(...h).toFixed(2)}, share > 0: ${(h.filter((x) => x > 0).length / h.length).toFixed(3)} (n=${h.length} seasons)`);
}

// ---------------------------------------------------------------------------
// The abstract's Table 1 (added 2026-09-29): four rules on the three criteria.
//   Help for a worse record   draft places gained when the 5th-worst record among the 14
//                             non-playoff teams drops to the worst record, everything else
//                             held. Exact for the 2019 lottery (pick_dist.js), Simple COLA
//                             and Full-lottery (record never read, so 0); the adopted 3-2-1
//                             is priced by simulating its draw MC_DRAWS times per season,
//                             with its pick floor and repeat limits.
//   Help for a longer wait    draft places gained when the 5th-longest wait among the 14
//                             non-playoff teams becomes the longest wait in the pool.
//                             Exact for Simple COLA (its order) and Full-lottery (Plackett-
//                             Luce expected pick over the pool by index); the two NBA
//                             lotteries never read a team's wait, so 0.
//   Longest wait              the "stuck" column above (series win or top-3 pick).
//   Wait to return / next win average length of every completed run of seasons out of the
//                             playoffs, and without a playoff series win.
// Run: node abstract_table.js --table1
if (flagsHas("--table1")) {
	const { pickDistribution, buildPool } = require("./pick_dist.js");
	const MC_DRAWS = 2000;
	const BALLS = { bottom3: 2, nonPlayIn: 3, seed910: 2, seed8: 1 };
	function t321Expected(teams, hist, tid) {
		const byConf = {};
		for (const t of teams) (byConf[t.conf] ??= []).push(t);
		const role = {};
		const pool = Object.values(byConf).flatMap((c) => {
			const w8 = c.slice().sort((a, b) => a.wins - b.wins).slice(0, 8);
			w8.forEach((t, i) => { role[t.tid] = i < 5 ? "nonPlayIn" : i < 7 ? "seed910" : "seed8"; });
			return w8;
		});
		pool.filter((t) => role[t.tid] === "nonPlayIn").sort((a, b) => a.wins - b.wins).slice(0, 3)
			.forEach((t) => { role[t.tid] = "bottom3"; });
		if (!pool.some((t) => t.tid === tid)) return null;
		const base = pool.map((t) => ({ tid: t.tid, w: BALLS[role[t.tid]], b3: role[t.tid] === "bottom3" }));
		const past = (id, back) => { const h = hist[id] ?? []; return h.length >= back ? h[h.length - back] : null; };
		let sum = 0;
		for (let n = 0; n < MC_DRAWS; n++) {
			const rem = base.slice();
			for (let pick = 1; rem.length; pick++) {
				let c = rem;
				if (pick === 1) { const f = c.filter((x) => past(x.tid, 1) !== 1); if (f.length) c = f; }
				if (pick <= 5) { const f = c.filter((x) => !((past(x.tid, 1) ?? 99) <= 5 && (past(x.tid, 2) ?? 99) <= 5)); if (f.length) c = f; }
				if (pick <= 12) { const b3 = c.filter((x) => x.b3); if (b3.length > 0 && b3.length >= 13 - pick) c = b3; }
				let roll = Math.random() * c.reduce((s, x) => s + x.w, 0);
				let ch = c[c.length - 1];
				for (const x of c) { roll -= x.w; if (roll < 0) { ch = x; break; } }
				if (ch.tid === tid) { sum += pick; break; }
				rem.splice(rem.indexOf(ch), 1);
			}
		}
		return sum / MC_DRAWS;
	}
	const worstRecord = {
		nba(log) { const out = []; for (const e of log) { const pool = e.teams.filter((t) => t.playoffRoundsWon < 0); if (pool.length !== 14) continue;
			const base = pickDistribution(buildPool(pool, "nba"), 4); const r = pool.slice().sort((a, b) => a.wins - b.wins); const t = r[4];
			const after = pickDistribution(buildPool(pool.map((x) => (x.tid === t.tid ? { ...x, wins: r[0].wins - 1 } : x)), "nba"), 4);
			out.push(base.ePick[t.tid] - after.ePick[t.tid]); } return mean(out); },
		t321(log) { const hist = {}; const out = []; for (const e of log) { const teams = e.teams.map((t) => ({ tid: t.tid, wins: t.wins, conf: t.conf }));
			const np = e.teams.filter((t) => t.playoffRoundsWon < 0).sort((a, b) => a.wins - b.wins);
			if (np.length === 14) { const tk = np[4]; const b = t321Expected(teams, hist, tk.tid);
				const a = t321Expected(teams.map((t) => (t.tid === tk.tid ? { ...t, wins: np[0].wins - 1 } : t)), hist, tk.tid);
				if (b != null && a != null) out.push(b - a); }
			for (const t of e.teams) (hist[t.tid] ??= []).push(t.draftPick); } return mean(out); },
		simplerule(log) { return simpleRuleReward(log)[5] ? mean(simpleRuleReward(log)[5]) : NaN; },
		full() { return 0; },
	};
	function simpleWaitHelp(log) { const drought = {}; const out = []; for (const e of log) {
		for (const t of e.teams) drought[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (drought[t.tid] ?? 0) + 1;
		const pool = e.teams.filter((t) => t.playoffRoundsWon < 1);
		const pick = (tid, d, w) => { let a = 0, ti = 0; for (const o of pool) { if (o.tid === tid) continue; const od = drought[o.tid]; if (od > d || (od === d && o.wins > w)) a++; else if (od === d && o.wins === w) ti++; } return 1 + a + ti / 2; };
		const np = e.teams.filter((t) => t.playoffRoundsWon < 0).sort((a, b) => (drought[b.tid] - drought[a.tid]) || (b.wins - a.wins));
		if (np.length === 14) { const t = np[4]; const maxd = Math.max(...pool.map((o) => drought[o.tid])); out.push(pick(t.tid, drought[t.tid], t.wins) - pick(t.tid, maxd + 1, t.wins)); }
		for (const t of e.teams) if ((t.draftPick ?? 99) <= 3) drought[t.tid] = 0; } return mean(out); }
	function fullWaitHelp(log) { const out = []; for (const e of log) { const np = e.teams.filter((t) => t.playoffRoundsWon < 0); if (np.length !== 14) continue;
		const w = Object.fromEntries(np.map((t) => [t.tid, t.colaPre ?? 0])); if (np.reduce((s, t) => s + w[t.tid], 0) === 0) continue;
		const ep = (tid, wi) => 1 + np.filter((o) => o.tid !== tid).reduce((s, o) => s + (w[o.tid] + wi > 0 ? w[o.tid] / (w[o.tid] + wi) : 0.5), 0);
		const sorted = np.slice().sort((a, b) => w[b.tid] - w[a.tid]); const t = sorted[4]; out.push(ep(t.tid, w[t.tid]) - ep(t.tid, w[sorted[0].tid] + 1000)); } return mean(out); }
	const longerWait = { nba: () => 0, t321: () => 0, simplerule: simpleWaitHelp, full: fullWaitHelp };
	function avgSpell(log, hit) { const now = {}, done = []; for (const e of log) for (const t of e.teams) { if (hit(t)) { if (now[t.tid] > 0) done.push(now[t.tid]); now[t.tid] = 0; } else now[t.tid] = (now[t.tid] ?? 0) + 1; } return mean(done); }
	const T1 = [["nba", "Old NBA lottery"], ["t321", "New lottery, 3-2-1"], ["simplerule", "Simple COLA"], ["full", "Full-lottery COLA"]];
	const perLeague = {};
	for (const [tag] of T1) {
		if (!logs[tag]) { console.error(`table1: ${tag} missing`); continue; }
		perLeague[tag] = logs[tag].map((r) => ({
			record: worstRecord[tag](r.seasonLog),
			wait: longerWait[tag](r.seasonLog),
			stuck: perLeague_stuck(r.seasonLog),
			ret: avgSpell(r.seasonLog, (t) => t.playoffRoundsWon >= 0),
			win: avgSpell(r.seasonLog, (t) => t.playoffRoundsWon >= 1),
		}));
	}
	function perLeague_stuck(log) { return Math.max(...longestRuns(log, (t) => t.playoffRoundsWon >= 1 || (t.draftPick ?? 99) <= 3)); }
	const col = (tag, k) => perLeague[tag].map((v) => v[k]);
	const fmt = (x, d) => (Math.abs(x) < 0.5 * 10 ** -d ? "0" : (x > 0 ? "+" : "") + x.toFixed(d));
	console.log("\nAbstract Table 1: four rules on the three criteria (means over the 30 leagues)\n");
	console.log("rule".padEnd(20) + ["worse record", "longer wait", "longest wait", "wait to return", "next series win"].map((h) => h.padStart(17)).join(""));
	for (const [tag, name] of T1) {
		if (!perLeague[tag]) continue;
		console.log(name.padEnd(20) + [fmt(mean(col(tag, "record")), 2), fmt(mean(col(tag, "wait")), 1).replace("+", ""), mean(col(tag, "stuck")).toFixed(1), mean(col(tag, "ret")).toFixed(2), mean(col(tag, "win")).toFixed(2)].map((s) => s.padStart(17)).join(""));
	}
	if (perLeague.t321) {
		console.log("\nPaired against 3-2-1, mean [95% CI] over the 30 leagues (negative = shorter wait or fewer places)\n");
		for (const tag of ["simplerule", "full", "nba"]) {
			if (!perLeague[tag]) continue;
			const cells = ["record", "wait", "stuck", "ret", "win"].map((k) => { const d = perLeague[tag].map((v, i) => v[k] - perLeague.t321[i][k]); const m = mean(d); const h = (T29 * sd(d)) / Math.sqrt(d.length); return `${m.toFixed(2)} [${(m - h).toFixed(2)}, ${(m + h).toFixed(2)}]`; });
			console.log(`${tag} minus t321: ` + cells.join(" | "));
		}
	}
}
