#!/usr/bin/env node
/**
 * Section 5's numbers, from the 25-season run (30 leagues x 25 seasons each).
 *
 * Reads runs/frontier/{nba,t321,full,simplerule}.json and prints, for the old
 * lottery, the adopted 3-2-1, Full-lottery COLA and Simple COLA:
 *
 * 1. The pool line. Every mechanism's pool ends somewhere, and a team just
 *    inside it picks earlier than a team just outside. For each mechanism this
 *    prints the pick of the team on the pool side and the first pick on the
 *    other side.
 *      old lottery   line = the last playoff place. Team = the best record
 *                    among the 14 that missed the playoffs, at its exact
 *                    expected pick (pick_dist.js). Other side = pick 15.
 *      3-2-1         line = the seven-eight play-in game. Team = the loser,
 *                    which holds one ball; as in the driver, the eighth-best
 *                    record in each conference stands in for it. Its expected
 *                    pick comes from DRAWS simulated drawings per season under
 *                    the adopted rules. Other side = pick 17.
 *      Full-lottery  line = the last playoff place. Team = the most tickets
 *                    among the 14 that missed the playoffs, at its exact
 *                    expected place in a drawing without replacement. Other
 *                    side = pick 15.
 *      Simple COLA   line = a first-round series. Team = the longest wait in
 *                    the pool (ties to more wins), at the pick the simulator
 *                    gave it. Other side = pick 23, the first pick among the
 *                    eight series winners.
 *    For the two COLA mechanisms the team is the one with the highest
 *    priority, so the figure is the most any team on the line can gain.
 * 2. Repeat top-three picks. Of the top-three picks made from each league's
 *    third season on, the share that went to a team that had received one in
 *    either of the two drafts before.
 * 3. The season after a top-three pick. For a team that took a top-three pick
 *    and missed the playoffs the next season, its pick that next season. Also
 *    the mean number of seasons between one team's top-three picks.
 *
 * The 3-2-1 drawings use a fixed-seed generator, so the output is identical on
 * every run.
 *
 * Usage: node limits_check.js [runsDir=runs/frontier]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { pickDistribution, buildPool } = require("./pick_dist.js");

const ROOT = process.argv[2] ?? "runs/frontier";
const MECHS = [
	["nba", "Old lottery"],
	["t321", "3-2-1"],
	["full", "Full-lottery COLA"],
	["simplerule", "Simple COLA"],
];

// Simulated drawings per season for 3-2-1, the count abstract_table.js uses.
const DRAWS = 2000;
// Balls per team under the adopted 3-2-1 (Table 1 of the paper): the three
// worst records 2, the other seven teams that miss the play-in 3, the ninth and
// tenth seeds 2, the seven-eight losers 1.
const BALLS = { bottom3: 2, nonPlayIn: 3, seed910: 2, seed8: 1 };
// First pick outside each pool: 14-team pools end at pick 14, the 3-2-1 pool at
// pick 16, and Simple COLA's pool of 22 at pick 22.
const FIRST_OUTSIDE = { nba: 15, t321: 17, full: 15, simplerule: 23 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const load = (tag) => JSON.parse(fs.readFileSync(path.join(ROOT, `${tag}.json`), "utf8"));

// mulberry32, a small fixed-seed generator, so the 3-2-1 figures reproduce.
function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// 1. The pool line
// ---------------------------------------------------------------------------

function lineOldLottery(reps) {
	const out = [];
	for (const rep of reps) {
		for (const e of rep.seasonLog) {
			const missed = e.teams.filter((t) => t.playoffRoundsWon < 0);
			const dist = pickDistribution(buildPool(missed, "nba"), 4);
			const best = missed.slice().sort((a, b) => b.wins - a.wins)[0];
			out.push(dist.ePick[best.tid]);
		}
	}
	return out;
}

// Expected pick of each seven-eight loser under the adopted 3-2-1 drawing: all
// 16 picks drawn by balls, no first pick in consecutive seasons, no third
// straight top-five pick, and the three worst records placed by pick 12.
function lineT321(reps) {
	const rand = seeded(20261111);
	const out = [];
	for (const rep of reps) {
		const hist = {};
		for (const e of rep.seasonLog) {
			const byConf = {};
			for (const t of e.teams) (byConf[t.conf] ??= []).push(t);
			const role = {};
			const pool = Object.values(byConf).flatMap((conf) => {
				const worst8 = conf.slice().sort((a, b) => a.wins - b.wins).slice(0, 8);
				worst8.forEach((t, i) => {
					role[t.tid] = i < 5 ? "nonPlayIn" : i < 7 ? "seed910" : "seed8";
				});
				return worst8;
			});
			pool
				.filter((t) => role[t.tid] === "nonPlayIn")
				.sort((a, b) => a.wins - b.wins)
				.slice(0, 3)
				.forEach((t) => {
					role[t.tid] = "bottom3";
				});
			const base = pool.map((t) => ({ tid: t.tid, w: BALLS[role[t.tid]], b3: role[t.tid] === "bottom3" }));
			const past = (tid, back) => {
				const h = hist[tid] ?? [];
				return h.length >= back ? h[h.length - back] : null;
			};
			const sum = Object.fromEntries(base.map((b) => [b.tid, 0]));
			for (let n = 0; n < DRAWS; n++) {
				const left = base.slice();
				for (let pick = 1; left.length; pick++) {
					let c = left;
					if (pick === 1) {
						const f = c.filter((x) => past(x.tid, 1) !== 1);
						if (f.length) c = f;
					}
					if (pick <= 5) {
						const f = c.filter((x) => !((past(x.tid, 1) ?? 99) <= 5 && (past(x.tid, 2) ?? 99) <= 5));
						if (f.length) c = f;
					}
					if (pick <= 12) {
						const b3 = c.filter((x) => x.b3);
						if (b3.length > 0 && b3.length >= 13 - pick) c = b3;
					}
					let roll = rand() * c.reduce((s, x) => s + x.w, 0);
					let chosen = c[c.length - 1];
					for (const x of c) {
						roll -= x.w;
						if (roll < 0) {
							chosen = x;
							break;
						}
					}
					sum[chosen.tid] += pick;
					left.splice(left.indexOf(chosen), 1);
				}
			}
			for (const b of base) if (role[b.tid] === "seed8") out.push(sum[b.tid] / DRAWS);
			for (const t of e.teams) (hist[t.tid] ??= []).push(t.draftPick);
		}
	}
	return out;
}

// Expected place of the top-ticket team when all 14 picks are drawn by tickets
// without replacement: one plus, for each rival, the chance the rival is drawn
// first, which is the rival's share of the two teams' tickets.
function lineFull(reps) {
	const out = [];
	for (const rep of reps) {
		for (const e of rep.seasonLog) {
			const missed = e.teams.filter((t) => t.playoffRoundsWon < 0);
			const w = Object.fromEntries(missed.map((t) => [t.tid, t.colaPre ?? 0]));
			if (missed.reduce((s, t) => s + w[t.tid], 0) === 0) continue;
			const top = missed.slice().sort((a, b) => w[b.tid] - w[a.tid])[0];
			out.push(1 + missed.filter((o) => o.tid !== top.tid).reduce((s, o) => s + w[o.tid] / (w[o.tid] + w[top.tid]), 0));
		}
	}
	return out;
}

function lineSimple(reps) {
	const out = [];
	for (const rep of reps) {
		const wait = {};
		for (const e of rep.seasonLog) {
			for (const t of e.teams) wait[t.tid] = t.playoffRoundsWon >= 1 ? 0 : (wait[t.tid] ?? 0) + 1;
			const pool = e.teams
				.filter((t) => t.playoffRoundsWon < 1)
				.sort((a, b) => wait[b.tid] - wait[a.tid] || b.wins - a.wins);
			out.push(pool[0].draftPick);
			for (const t of e.teams) if ((t.draftPick ?? 99) <= 3) wait[t.tid] = 0;
		}
	}
	return out;
}

const LINE = { nba: lineOldLottery, t321: lineT321, full: lineFull, simplerule: lineSimple };

// ---------------------------------------------------------------------------
// 2 and 3. Top-three picks: repeats, the season after, and the gap between them
// ---------------------------------------------------------------------------

function topThree(reps) {
	let picks = 0;
	let repeats = 0;
	const after = [];
	const gaps = [];
	for (const rep of reps) {
		const log = rep.seasonLog;
		const last = {};
		for (let s = 0; s < log.length; s++) {
			const prev = s > 0 ? new Map(log[s - 1].teams.map((t) => [t.tid, t])) : null;
			for (const t of log[s].teams) {
				if (prev && t.playoffRoundsWon < 0 && (prev.get(t.tid).draftPick ?? 99) <= 3) after.push(t.draftPick);
				if ((t.draftPick ?? 99) <= 3) {
					if (s >= 2) {
						picks++;
						if (last[t.tid] != null && s - last[t.tid] <= 2) repeats++;
					}
					if (last[t.tid] != null) gaps.push(s - last[t.tid]);
					last[t.tid] = s;
				}
			}
		}
	}
	return { picks, repeats, after, gaps };
}

// ---------------------------------------------------------------------------

console.log(`\nSection 5, ${ROOT}\n`);
console.log("1. The pool line: pick of the team on the pool side, first pick on the other side\n");
console.log("mechanism".padEnd(20) + ["pool side", "other side", "places", "seasons or teams"].map((h) => h.padStart(18)).join(""));
const rows = {};
for (const [tag, name] of MECHS) {
	const reps = load(tag);
	rows[tag] = { reps };
	const inside = LINE[tag](reps);
	const m = mean(inside);
	console.log(name.padEnd(20) + [m.toFixed(2), String(FIRST_OUTSIDE[tag]), (FIRST_OUTSIDE[tag] - m).toFixed(2), String(inside.length)].map((s) => s.padStart(18)).join(""));
}

console.log("\n2 and 3. Top-three picks\n");
console.log("mechanism".padEnd(20) + ["repeat within 2", "of picks", "share", "pick after", "n", "seasons between", "n"].map((h) => h.padStart(18)).join(""));
for (const [tag, name] of MECHS) {
	const r = topThree(rows[tag].reps);
	console.log(
		name.padEnd(20) +
			[String(r.repeats), String(r.picks), `${((100 * r.repeats) / r.picks).toFixed(1)}%`, mean(r.after).toFixed(2), String(r.after.length), mean(r.gaps).toFixed(2), String(r.gaps.length)]
				.map((s) => s.padStart(18))
				.join(""),
	);
}
console.log("");
