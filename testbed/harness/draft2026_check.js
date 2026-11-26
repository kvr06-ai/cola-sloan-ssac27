#!/usr/bin/env node
/**
 * Section 8's illustration: what each of the ten mechanisms would have done
 * with the 2026 draft.
 *
 * Reads data/nba-data.json and scores the 2025-26 season on its own final
 * standings and playoff results. Every team's carried-over priority comes from
 * the real seasons since 1999-00, and no season is replayed: each earlier
 * season keeps the picks the NBA actually made, as in Section 6.5's check of
 * real standings. A pick is credited to the team that held it on lottery day,
 * as measures.js does for real seasons.
 *
 * The carried-over priorities:
 *   wait     Simple COLA and Countdown COLA: seasons since the team last won a
 *            playoff series or received a top-three pick (measures.js walk()).
 *   tickets  Classic, Waitlist and Full-lottery COLA: 1,000 tickets in each
 *            season without a series win; a series win multiplies a team's
 *            tickets by 0.75, two by 0.5, three by 0.25 and a title by 0; picks
 *            1 to 4 multiply them by 0, 0.25, 0.5 and 0.75. These are the
 *            simulator's own rules (zengm-fork src/worker/core/draft/cola.ts,
 *            PLAYOFF_FACTORS and DRAFT_LOTTERY_FACTORS, rounded as there).
 *   count    Beckett COLA: seasons since a series win, a top-six finish in the
 *            conference by wins, or the first pick (measures.js walk()).
 *   stock    Capped COLA: each season's wins for a team that reached the
 *            playoffs through the play-in or missed them, up to 150 tickets;
 *            10% off for a play-in team that lost in round 1, 20% off for any
 *            other round-1 loser; 40% to 100% off for 1 to 4 series won, and
 *            100% to 20% off for picks 1 to 5 (measures.js walk() and
 *            cappedTickets()). Its pool leaves out the teams that won a series
 *            in 2025-26 or 2024-25 and the teams with a top-five pick in 2025.
 *
 * For each team it prints the chance of the first pick under each mechanism
 * with a drawing, and its pick under Simple COLA, which holds no drawing.
 *   old       the 2019 odds by record among the 14 teams that missed the
 *             playoffs; teams with the same record share their odds equally.
 *   uniform   one chance in 14 for each of those teams.
 *   t321      3-2-1 as adopted, on the real play-in results: chances 2 for the
 *             three worst records, 3 for the other seven teams that missed the
 *             play-in, 2 for the ninth and tenth seeds and 1 for the losers of
 *             the seven-eight games; a team that received the first pick in the
 *             2025 draft, or top-five picks in both 2024 and 2025, cannot
 *             receive the first pick.
 *   classic, waitlist, full   tickets as a share of the pool's tickets.
 *   countdown the chance of being the last team placed when the order is
 *             filled from the last pick up (measures.js countdownPicks()).
 *   beckett   entries, count times wins, as a share of the pool's entries.
 *   capped    tickets as a share of the pool's tickets.
 *
 * Nothing here is sampled, so the output is identical on every run.
 *
 * Usage: node draft2026_check.js [realFile=data/nba-data.json] [--json file]
 */

"use strict";

const fs = require("fs");
const M = require("./measures.js");
const { NBA_BALLS } = require("./pick_dist.js");

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const JSON_OUT = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const REAL = args[0] ?? "data/nba-data.json";

const SEASON = "2025-26";
// The simulator's ticket rules (cola.ts): 1,000 a season without a series win,
// these factors by series won, and these factors for picks 1 to 4.
const TICKET_STEP = 1000;
const SERIES_FACTORS = [0.75, 0.5, 0.25, 0];
const PICK_FACTORS = [0, 0.25, 0.5, 0.75];
// 3-2-1's chances by role (measures.js T321_CHANCES, Table 1 of the paper).
const T321_CHANCES = { bottom3: 2, nonPlayIn: 3, seed910: 2, seed8: 1 };
// Countdown COLA's chances from the lowest score up; with fewer than five teams
// left, the last entries of the list, so the highest holds 2 (measures.js).
const COUNTDOWN_CHANCES = [6, 5, 4, 3, 2];

const MECHS = [
	["old", "Old lottery"],
	["uniform", "Equal-odds lottery"],
	["t321", "3-2-1"],
	["classic", "Classic COLA"],
	["waitlist", "Waitlist COLA"],
	["full", "Full-lottery COLA"],
	["countdown", "Countdown COLA"],
	["beckett", "Beckett COLA"],
	["capped", "Capped COLA"],
];

const raw = JSON.parse(fs.readFileSync(REAL, "utf8"));
const league = M.fromReal(raw);
const last = league.findIndex((s) => s.label === SEASON);
if (last !== league.length - 1) throw new Error(`${SEASON} is not the last season in ${REAL}`);
const rawTeams = new Map(raw.seasons[last].teams.map((t) => [t.id, t]));
const names = new Map(raw.seasons[last].teams.map((t) => [t.id, t.name]));

// ---------------------------------------------------------------------------
// The carried-over priorities as the 2026 draft begins
// ---------------------------------------------------------------------------

let state = null;
let season = null;
const tickets = {};
M.walk(league, (s, st, index) => {
	const seriesWon = new Map(raw.seasons[index].teams.map((t) => [t.id, t.seriesWon ?? 0]));
	for (const t of s.teams) {
		const won = seriesWon.get(t.id);
		tickets[t.id] = won > 0 ? Math.round((tickets[t.id] ?? 0) * SERIES_FACTORS[Math.min(won, 4) - 1]) : (tickets[t.id] ?? 0) + TICKET_STEP;
	}
	if (index === last) {
		// walk() reuses its objects, so keep copies taken before this draft.
		state = { wait: { ...st.wait }, count: { ...st.count }, cappedBefore: { ...st.cappedBefore }, past: JSON.parse(JSON.stringify(st.past)) };
		season = s;
		return;
	}
	for (const t of s.teams) if ((t.pick ?? 99) <= 4) tickets[t.id] = Math.round(tickets[t.id] * PICK_FACTORS[t.pick - 1]);
});
const teams = season.teams;
const byId = new Map(teams.map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// The chance of the first pick under each mechanism with a drawing
// ---------------------------------------------------------------------------

const missed = teams.filter((t) => t.missed).sort((a, b) => a.wins - b.wins);
if (missed.length !== 14) throw new Error(`${missed.length} teams missed the playoffs`);
const share = (weights) => {
	const total = Object.values(weights).reduce((s, w) => s + w, 0);
	return Object.fromEntries(Object.entries(weights).map(([id, w]) => [id, w / total]));
};

const chance = {};

// The old lottery: the 2019 odds by rank, shared equally within a tie.
{
	const w = {};
	for (let i = 0; i < missed.length; ) {
		let j = i;
		while (j < missed.length && missed[j].wins === missed[i].wins) j++;
		const balls = NBA_BALLS.slice(i, j).reduce((s, b) => s + b, 0) / (j - i);
		for (let k = i; k < j; k++) w[missed[k].id] = balls;
		i = j;
	}
	chance.old = share(w);
}

chance.uniform = Object.fromEntries(missed.map((t) => [t.id, 1 / missed.length]));

// 3-2-1 on the real play-in. In each conference the seven-eight game is played
// by the two play-in teams with the best records; a tie for the second place
// goes to the team that advanced. Its loser is the one of the two that did not
// finish as the seventh seed.
const roles = {};
{
	for (const conf of ["E", "W"]) {
		const playIn = teams
			.filter((t) => t.conf === conf && rawTeams.get(t.id).playInParticipant)
			.sort((a, b) => b.wins - a.wins || Number(rawTeams.get(b.id).playInAdvanced) - Number(rawTeams.get(a.id).playInAdvanced));
		if (playIn.length !== 4) throw new Error(`${conf}: ${playIn.length} play-in teams`);
		const [a, b] = playIn;
		const loser = rawTeams.get(a.id).playoffSeed === 7 ? b : a;
		roles[loser.id] = "seed8";
		for (const t of playIn.slice(2)) roles[t.id] = "seed910";
	}
	const nonPlayIn = missed.filter((t) => !rawTeams.get(t.id).playInParticipant);
	nonPlayIn.forEach((t, i) => (roles[t.id] = i < 3 ? "bottom3" : "nonPlayIn"));
	const back = (id, k) => {
		const h = state.past[id] ?? [];
		return h.length >= k ? h[h.length - k] : null;
	};
	const barred = (id) => back(id, 1) === 1 || ((back(id, 1) ?? 99) <= 5 && (back(id, 2) ?? 99) <= 5);
	const w = {};
	for (const [id, role] of Object.entries(roles)) w[id] = barred(id) ? 0 : T321_CHANCES[role];
	chance.t321 = share(w);
	chance.t321Barred = Object.keys(roles).filter(barred);
}

for (const mech of ["classic", "waitlist", "full"]) chance[mech] = share(Object.fromEntries(missed.map((t) => [t.id, tickets[t.id]])));

// Countdown COLA: the distribution of each team's pick, by the method of
// measures.js countdownPicks(), whose expected picks it must reproduce.
function countdownDistribution() {
	const order = teams
		.filter((t) => !t.wonSeries)
		.map((t) => ({ id: t.id, score: state.wait[t.id] * t.wins, wait: state.wait[t.id], wins: t.wins }))
		.sort((a, b) => b.score - a.score || b.wait - a.wait || b.wins - a.wins)
		.reverse();
	const n = order.length;
	const width = COUNTDOWN_CHANCES.length;
	const dist = new Map();
	order.forEach((team, position) => {
		let below = new Array(width).fill(0);
		below[Math.min(position, width - 1)] = 1;
		const pickChance = new Array(n + 1).fill(0);
		for (let placed = Math.max(0, position - (width - 1)); placed < n; placed++) {
			const size = Math.min(width, n - placed);
			const offset = width - size;
			let total = 0;
			for (let k = 0; k < size; k++) total += COUNTDOWN_CHANCES[offset + k];
			const next = new Array(width).fill(0);
			let lower = 0;
			for (let r = 0; r < size; r++) {
				const p = below[r];
				if (p > 0) {
					pickChance[n - placed] += (p * COUNTDOWN_CHANCES[offset + r]) / total;
					if (r > 0) next[r - 1] += (p * lower) / total;
					next[r] += (p * (total - lower - COUNTDOWN_CHANCES[offset + r])) / total;
				}
				lower += COUNTDOWN_CHANCES[offset + r];
			}
			below = next;
		}
		dist.set(team.id, pickChance);
	});
	return dist;
}
const countdown = countdownDistribution();
const countdownCheck = M.countdownPicks(teams, state.wait);
for (const [id, d] of countdown) {
	const expected = d.reduce((s, p, pick) => s + p * pick, 0);
	if (Math.abs(expected - countdownCheck.get(id)) > 1e-9) throw new Error(`Countdown mismatch for ${id}`);
}
chance.countdown = Object.fromEntries([...countdown].map(([id, d]) => [id, d[1]]));

// Beckett COLA: entries as a share of the pool's entries.
chance.beckett = share(Object.fromEntries(teams.filter((t) => state.count[t.id] >= 2).map((t) => [t.id, state.count[t.id] * t.wins])));

// Capped COLA: tickets as a share of the pool's tickets. walk() marked the pool.
const stock = M.cappedTickets(teams, state.cappedBefore);
chance.capped = share(Object.fromEntries(teams.filter((t) => t.cappedPool).map((t) => [t.id, stock[t.id]])));

// Simple COLA: the pick itself. A tie on both wait and wins is a coin flip,
// which counts as half a place, as in measures.js.
const simple = Object.fromEntries(
	teams.filter((t) => !t.wonSeries).map((t) => [t.id, M.expectedPick("simple", teams, state.wait, state.past, t.id)]),
);

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

const inAnyPool = new Set([...missed.map((t) => t.id), ...Object.keys(roles), ...Object.keys(simple), ...Object.keys(chance.beckett), ...Object.keys(chance.capped)]);
const rows = [...inAnyPool]
	.map((id) => byId.get(id))
	.sort((a, b) => a.wins - b.wins || a.id.localeCompare(b.id))
	.map((t) => ({
		id: t.id,
		name: names.get(t.id),
		wins: t.wins,
		missed: t.missed,
		wait: state.wait[t.id],
		tickets: tickets[t.id],
		count: state.count[t.id],
		stock: stock[t.id],
		// null for a team outside the mechanism's pool; 0 for a pool team that
		// cannot receive the first pick.
		firstPick: Object.fromEntries(MECHS.map(([m]) => [m, t.id in chance[m] ? chance[m][t.id] : null])),
		simplePick: simple[t.id] ?? null,
	}));

const pct = (x) => (x == null ? "-" : (100 * x).toFixed(1));
const W = [24, 5, 5, 8, 6, 7, ...MECHS.map(() => 9), 8];
const pad = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(W[0]) : String(c).padStart(W[i]))).join("");
console.log(`\nThe 2026 draft under each mechanism, scored on the ${SEASON} season with priorities carried over from ${league[0].label}\n`);
console.log("Chance of the first pick, in percent; Simple COLA holds no drawing, so its column is the pick itself\n");
console.log(pad(["team", "wins", "wait", "tickets", "count", "stock", ...MECHS.map(([, n]) => n.replace(" COLA", "").replace(" lottery", "")), "Simple"]));
for (const r of rows) {
	console.log(pad([r.name, r.wins, r.wait, r.tickets, r.count, r.stock, ...MECHS.map(([m]) => pct(r.firstPick[m])), r.simplePick ?? "-"]));
}
console.log("");
console.log(`Chances sum to 100% in every column: ${MECHS.every(([m]) => Math.abs(Object.values(chance[m]).reduce((s, x) => s + x, 0) - 1) < 1e-12)}`);
console.log(`3-2-1 pool: ${Object.keys(roles).length} teams; losers of the seven-eight games: ${Object.keys(roles).filter((id) => roles[id] === "seed8").join(", ")}; barred from the first pick: ${chance.t321Barred.join(", ") || "none"}`);
console.log(`Simple COLA's pool: ${Object.keys(simple).length} teams; Beckett COLA's pool: ${Object.keys(chance.beckett).length} teams; Capped COLA's pool: ${Object.keys(chance.capped).length} teams`);
console.log(`Countdown COLA's distributions reproduce measures.js countdownPicks() for all ${countdown.size} teams`);
console.log("");

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ season: SEASON, from: league[0].label, mechanisms: MECHS.map(([tag, name]) => ({ tag, name })), rows }, null, 1));
