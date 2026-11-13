/**
 * The paper's measures, written once, so that a table computes them the same
 * way on a simulated league and on real NBA seasons.
 *
 * A league is a list of seasons in order. A season is { label, teams }, and a
 * team is
 *   id         the same id in every season of the league
 *   conf       "E" or "W"
 *   wins       regular-season wins
 *   rec        share of its games won this season
 *   missed     true if it missed the playoffs (a play-in loser missed them)
 *   wonSeries  true if it won at least one playoff series
 *   pick       its first-round pick in the draft that followed, or null
 *   tickets    its lottery tickets before the drawing (simulated leagues only)
 * fromSim() builds a league from one replicate of a run file, and fromReal()
 * builds one from data/nba-data.json.
 *
 * Measures
 *   waitLengths(league, hit)   length of every completed run of seasons a team
 *                              spends without `hit`. With hit = made the
 *                              playoffs it is the wait to return to the
 *                              playoffs; with hit = won a series it is the wait
 *                              for the next series win. A run still open when
 *                              the league ends is left out.
 *   longestWait(league)        the longest run of seasons any team spends with
 *                              neither a playoff series win nor a top-three pick.
 *   rewardForLosing(mech, ...) draft places a team gains when its record alone
 *                              drops to the worst in the league. The team is
 *                              the one with the `rank`-th worst record among
 *                              the 14 that missed the playoffs. A positive
 *                              value is an earlier pick.
 *   helpForWaiting(mech, ...)  draft places a team gains when its priority alone
 *                              rises to one step above the highest in its pool.
 *                              The team is the one with the `rank`-th highest
 *                              priority among the 14 that missed the playoffs.
 *                              A step is one season of waiting or 1,000 tickets.
 *                              Zero for a lottery in which nothing carries over.
 * Both help measures are expectations over the mechanism's drawing, computed
 * exactly for all nine mechanisms (expectedPick() below), so they carry no
 * sampling error:
 *   "old"        the 2019 to 2026 lottery     raffleThenOrder() enumerates its four drawn picks
 *   "uniform"    equal-odds lottery           every pool team expects pick 7.5
 *   "t321"       3-2-1 as adopted             t321Picks() sums over every state of its drawing
 *   "classic"    Classic COLA                 raffleThenOrder(), tickets then record
 *   "waitlist"   Waitlist COLA                raffleThenOrder(), tickets then tickets
 *   "full"       Full-lottery COLA            closed form for a drawing of every pick
 *   "simple"     Simple COLA                  no drawing
 *   "countdown"  Countdown COLA               countdownPicks() follows each team through its drawing
 *   "beckett"    Beckett COLA                 raffleThenOrder(), entries then entries
 *
 * Carry-over state comes from the league's own history, walked in order by
 * walk(): each team's wait under Simple COLA and Countdown COLA (seasons since
 * it last won a playoff series or received a top-three pick), its count under
 * Beckett COLA, and its picks in earlier drafts, which 3-2-1's limits on repeat
 * picks read. Tickets come from the run file itself.
 */

"use strict";

const { NBA_BALLS } = require("./pick_dist.js");

// The simulator plays an 82-game season (zengm-fork defaultGameAttributes.ts,
// numGames).
const SIM_GAMES = 82;

// NBA conferences, unchanged since 2004-05, when New Orleans moved to the West
// and Charlotte joined the East. Every season scored on real standings is
// 2004-05 or later, so this is each season's own alignment.
const EAST = ["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL", "NYK", "ORL", "PHI", "TOR", "WAS"];

// Chances per team in the 3-2-1 drawing as adopted (Table 1 of the paper): the
// three worst records 2, the other seven teams that miss the play-in 3, the
// ninth and tenth seeds 2, the losers of the seven-eight games 1.
const T321_CHANCES = { bottom3: 2, nonPlayIn: 3, seed910: 2, seed8: 1 };

// Countdown COLA draws each pick from the five lowest scores left, with these
// chances from the lowest score up (the driver's COUNTDOWN_POOL_TICKETS).
const COUNTDOWN_CHANCES = [6, 5, 4, 3, 2];

// One step of priority: a season of waiting, or the 1,000 tickets a team gains
// in a season without a playoff series win (Section 3 of the paper).
const TICKET_STEP = 1000;

const NO_CARRY_OVER = new Set(["old", "uniform", "t321"]);
const TICKET_MECHS = new Set(["classic", "waitlist", "full"]);

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

function fromSim(rep) {
	return rep.seasonLog.map((e, i) => ({
		label: String(i + 1),
		teams: e.teams.map((t) => ({
			id: t.tid,
			conf: t.conf,
			wins: t.wins,
			rec: t.wins / SIM_GAMES,
			missed: t.playoffRoundsWon < 0,
			wonSeries: t.playoffRoundsWon >= 1,
			pick: t.draftPick ?? null,
			tickets: t.colaPre ?? 0,
		})),
	}));
}

function fromReal(data) {
	return data.seasons.map((s) => ({
		label: s.season,
		teams: s.teams.map((t) => ({
			id: t.id,
			conf: EAST.includes(t.id) ? "E" : "W",
			wins: t.wins,
			rec: t.wins / (t.wins + t.losses),
			missed: !t.madePlayoffs,
			wonSeries: t.seriesWon >= 1,
			pick: t.draftPick ?? null,
		})),
	}));
}

// Beckett COLA's count after a season's playoffs: zero for a team that won a
// series or finished in the top six of its conference, and one more than before
// for every other team. The driver reads the top six from regular-season wins.
function beckettCounts(teams, before) {
	const byConf = {};
	for (const t of teams) (byConf[t.conf] ??= []).push(t);
	const topSix = new Set();
	for (const conf of Object.values(byConf)) {
		conf.slice().sort((a, b) => b.wins - a.wins).slice(0, 6).forEach((t) => topSix.add(t.id));
	}
	const count = {};
	for (const t of teams) count[t.id] = t.wonSeries || topSix.has(t.id) ? 0 : (before[t.id] ?? 0) + 1;
	return count;
}

// Calls fn(season, state, index) for each season in order. The state holds, for
// that season's draft:
//   wait         each team's wait after the season's playoffs
//   count        each team's Beckett count after the season's playoffs
//   countBefore  the Beckett counts the season started with
//   past         each team's picks in earlier drafts, oldest first
function walk(league, fn) {
	const wait = {};
	const past = {};
	let count = {};
	league.forEach((season, index) => {
		for (const t of season.teams) wait[t.id] = t.wonSeries ? 0 : (wait[t.id] ?? 0) + 1;
		const countBefore = count;
		count = beckettCounts(season.teams, countBefore);
		fn(season, { wait, past, count, countBefore }, index);
		for (const t of season.teams) {
			if ((t.pick ?? 99) <= 3) wait[t.id] = 0;
			if (t.pick === 1) count[t.id] = 0;
			(past[t.id] ??= []).push(t.pick);
		}
	});
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

function waitLengths(league, hit) {
	const now = {};
	const done = [];
	for (const season of league) {
		for (const t of season.teams) {
			if (hit(t)) {
				if (now[t.id] > 0) done.push(now[t.id]);
				now[t.id] = 0;
			} else now[t.id] = (now[t.id] ?? 0) + 1;
		}
	}
	return done;
}

function longestWait(league) {
	const now = {};
	let longest = 0;
	for (const season of league) {
		for (const t of season.teams) {
			now[t.id] = t.wonSeries || (t.pick ?? 99) <= 3 ? 0 : (now[t.id] ?? 0) + 1;
			longest = Math.max(longest, now[t.id]);
		}
	}
	return longest;
}

// ---------------------------------------------------------------------------
// The 3-2-1 drawing, exactly
// ---------------------------------------------------------------------------

// Expected pick of every team in the 3-2-1 pool. The pool is the eight worst
// records in each conference: five that miss the play-in, the ninth and tenth
// seeds, and the eighth-best record, which stands in for the loser of the
// seven-eight game as it does in the simulator's driver. All 16 picks are
// drawn, each among the teams still left and in proportion to their chances,
// under the adopted limits: no first pick in consecutive seasons, no third
// straight top-five pick, and the three worst records placed by pick 12. A
// limit that would leave no team to draw is skipped, as in the driver.
//
// Teams that hold the same chances and fall under the same limits are
// interchangeable, so the drawing is followed by how many teams of each kind
// are still left. The pick number follows from that count, and one pass over
// the counts gives each kind's expected picks with no sampling. Every team of
// a kind expects the same pick.
function t321Picks(teams, past) {
	const byConf = {};
	for (const t of teams) (byConf[t.conf] ??= []).push(t);
	const role = new Map();
	const pool = [];
	for (const conf of Object.values(byConf)) {
		const worst8 = conf.slice().sort((a, b) => a.rec - b.rec).slice(0, 8);
		worst8.forEach((t, i) => role.set(t.id, i < 5 ? "nonPlayIn" : i < 7 ? "seed910" : "seed8"));
		pool.push(...worst8);
	}
	pool
		.filter((t) => role.get(t.id) === "nonPlayIn")
		.sort((a, b) => a.rec - b.rec)
		.slice(0, 3)
		.forEach((t) => role.set(t.id, "bottom3"));

	const back = (id, k) => {
		const h = past[id] ?? [];
		return h.length >= k ? h[h.length - k] : null;
	};
	// The kinds of team in this pool, and the kind of each team.
	const kinds = [];
	const kindOf = pool.map((t) => {
		const kind = {
			chances: T321_CHANCES[role.get(t.id)],
			bottom3: role.get(t.id) === "bottom3",
			hadFirst: back(t.id, 1) === 1,
			hadTwoTopFive: (back(t.id, 1) ?? 99) <= 5 && (back(t.id, 2) ?? 99) <= 5,
		};
		let k = kinds.findIndex((o) => o.chances === kind.chances && o.bottom3 === kind.bottom3 && o.hadFirst === kind.hadFirst && o.hadTwoTopFive === kind.hadTwoTopFive);
		if (k < 0) k = kinds.push({ ...kind, size: 0 }) - 1;
		kinds[k].size++;
		return k;
	});

	// A state is the number of teams left of each kind, packed into one integer.
	const step = [];
	let states = 1;
	for (const kind of kinds) {
		step.push(states);
		states *= kind.size + 1;
	}
	const n = pool.length;
	const prob = new Float64Array(states);
	const expected = new Float64Array(kinds.length);
	prob[states - 1] = 1;
	const left = new Array(kinds.length);
	// Drawing a team lowers the packed integer, so one downward pass visits every
	// state after all the states that lead to it.
	for (let code = states - 1; code > 0; code--) {
		const p = prob[code];
		if (p === 0) continue;
		let remaining = 0;
		for (let k = 0; k < kinds.length; k++) {
			left[k] = Math.floor(code / step[k]) % (kinds[k].size + 1);
			remaining += left[k];
		}
		const pick = n - remaining + 1;
		let cands = kinds.map((_, k) => k).filter((k) => left[k] > 0);
		if (pick === 1) {
			const free = cands.filter((k) => !kinds[k].hadFirst);
			if (free.length) cands = free;
		}
		if (pick <= 5) {
			const free = cands.filter((k) => !kinds[k].hadTwoTopFive);
			if (free.length) cands = free;
		}
		if (pick <= 12) {
			const worst = cands.filter((k) => kinds[k].bottom3);
			const count = worst.reduce((s, k) => s + left[k], 0);
			if (count > 0 && count >= 13 - pick) cands = worst;
		}
		const total = cands.reduce((s, k) => s + left[k] * kinds[k].chances, 0);
		for (const k of cands) {
			const q = (p * left[k] * kinds[k].chances) / total;
			expected[k] += q * pick;
			prob[code - step[k]] += q;
		}
	}
	return new Map(pool.map((t, i) => [t.id, expected[kindOf[i]] / kinds[kindOf[i]].size]));
}

// ---------------------------------------------------------------------------
// The Countdown COLA drawing, exactly
// ---------------------------------------------------------------------------

// Expected pick of every team in Countdown COLA's pool, the teams without a
// series win. A team's score is its wait times its wins. The order is filled
// from the last pick to the first, and each step draws one team from the five
// lowest scores left, with chances 6, 5, 4, 3, 2 from the lowest up. Ties on
// score go to the longer wait, then to more wins, as in the driver.
//
// Put the teams in score order, lowest first. A team joins the five lowest
// when all but four of the teams below it are placed. From then on, the only
// thing that matters to it is how many of the five sit below it: a draw from
// below moves it down one, a draw from above changes nothing for it, and its
// own draw places it. Following that count gives its expected pick exactly.
function countdownPicks(teams, wait) {
	const order = teams
		.filter((t) => !t.wonSeries)
		.map((t) => ({ id: t.id, score: wait[t.id] * t.wins, wait: wait[t.id], wins: t.wins }))
		.sort((a, b) => b.score - a.score || b.wait - a.wait || b.wins - a.wins)
		.reverse();
	const n = order.length;
	const width = COUNTDOWN_CHANCES.length;
	const picks = new Map();
	order.forEach((team, position) => {
		// below[r] is the chance that r of the lowest scores left sit below this team.
		let below = new Array(width).fill(0);
		below[Math.min(position, width - 1)] = 1;
		let expected = 0;
		for (let placed = Math.max(0, position - (width - 1)); placed < n; placed++) {
			const size = Math.min(width, n - placed);
			let total = 0;
			for (let k = 0; k < size; k++) total += COUNTDOWN_CHANCES[k];
			const next = new Array(width).fill(0);
			let lower = 0; // chances held by the teams below this one
			for (let r = 0; r < size; r++) {
				const p = below[r];
				if (p > 0) {
					expected += ((p * COUNTDOWN_CHANCES[r]) / total) * (n - placed);
					if (r > 0) next[r - 1] += (p * lower) / total;
					next[r] += (p * (total - lower - COUNTDOWN_CHANCES[r])) / total;
				}
				lower += COUNTDOWN_CHANCES[r];
			}
			below = next;
		}
		picks.set(team.id, expected);
	});
	return picks;
}

// ---------------------------------------------------------------------------
// A drawing of the first picks followed by a fixed order, for one team
// ---------------------------------------------------------------------------

// Expected pick of team `id` when the first `depth` picks are drawn in
// proportion to weight w, and the rest follow in order of key, highest first.
// A tie on key is settled arbitrarily, so it counts as half a place. Every
// ordered set of drawn teams is enumerated, which is exact. pick_dist.js does
// the same for all teams of a 14-team pool at once and agrees with this to
// twelve decimal places; this version follows one team, so it stays fast.
function raffleThenOrder(pool, id, depth = 4) {
	const n = pool.length;
	const me = pool.findIndex((t) => t.id === id);
	const better = pool.map((t) => t.key > pool[me].key);
	const equal = pool.map((t, i) => i !== me && t.key === pool[me].key);
	const allBetter = better.filter(Boolean).length;
	const allEqual = equal.filter(Boolean).length;
	const drawn = new Array(n).fill(false);
	const slots = Math.min(depth, n);
	let expected = 0;
	const draw = (slot, total, prob, drawnBetter, drawnEqual) => {
		if (slot === slots || total <= 0) {
			// The drawing is over, or no chances are left: the rest follow in order.
			expected += prob * (slot + 1 + (allBetter - drawnBetter) + (allEqual - drawnEqual) / 2);
			return;
		}
		for (let i = 0; i < n; i++) {
			if (drawn[i] || pool[i].w <= 0) continue;
			const p = (prob * pool[i].w) / total;
			if (i === me) {
				expected += p * (slot + 1);
				continue;
			}
			drawn[i] = true;
			draw(slot + 1, total - pool[i].w, p, drawnBetter + (better[i] ? 1 : 0), drawnEqual + (equal[i] ? 1 : 0));
			drawn[i] = false;
		}
	};
	draw(0, pool.reduce((s, t) => s + Math.max(0, t.w), 0), 1, 0, 0);
	return expected;
}

// ---------------------------------------------------------------------------
// Expected pick of one team under each mechanism
// ---------------------------------------------------------------------------

// Simple COLA: place in the pool of teams without a series win, by longest
// wait and then by better record. A tie on both is settled by a coin flip, so
// it counts as half a place.
function simplePlace(teams, wait, id, myWait, myRec) {
	let ahead = 0;
	let tied = 0;
	for (const o of teams) {
		if (o.id === id || o.wonSeries) continue;
		if (wait[o.id] > myWait || (wait[o.id] === myWait && o.rec > myRec)) ahead++;
		else if (wait[o.id] === myWait && o.rec === myRec) tied++;
	}
	return 1 + ahead + tied / 2;
}

// Beckett COLA: the pool is every team with a count of two or more. Entries are
// count times wins. The first four picks are drawn by entries and the rest of
// the pool follows in order of entries. A team that missed the playoffs and is
// outside the pool picks after it, worst record first.
function beckettPick(teams, count, id) {
	const me = teams.find((t) => t.id === id);
	const pool = teams
		.filter((t) => count[t.id] >= 2)
		.map((t) => ({ id: t.id, w: count[t.id] * t.wins, key: count[t.id] * t.wins }));
	if (count[id] >= 2) return raffleThenOrder(pool, id, 4);
	if (!me.missed) return null;
	let ahead = 0;
	let tied = 0;
	for (const o of teams) {
		if (o.id === id || count[o.id] >= 2 || !o.missed) continue;
		if (o.wins < me.wins) ahead++;
		else if (o.wins === me.wins) tied++;
	}
	return pool.length + 1 + ahead + tied / 2;
}

// The priority each mechanism carries over, for every team in a season.
function priorityOf(mech, teams, state) {
	if (mech === "simple" || mech === "countdown") return state.wait;
	if (mech === "beckett") return beckettCounts(teams, state.countBefore);
	if (TICKET_MECHS.has(mech)) return Object.fromEntries(teams.map((t) => [t.id, t.tickets ?? 0]));
	return {};
}

// Expected pick of team `id` this season, or null if the mechanism does not
// place it. `pri` is the priority of every team (priorityOf), which a caller
// may alter for one team; `past` holds every team's earlier picks.
function expectedPick(mech, teams, pri, past, id) {
	const me = teams.find((t) => t.id === id);
	const missed = teams.filter((t) => t.missed);
	if (mech === "old") {
		if (!me.missed) return null;
		// Chances follow the rank by record, worst first. The first four picks
		// are drawn and the rest go in reverse order of record.
		const pool = missed
			.slice()
			.sort((a, b) => a.rec - b.rec)
			.map((t, i) => ({ id: t.id, w: NBA_BALLS[i] ?? NBA_BALLS.at(-1), key: -t.rec }));
		return raffleThenOrder(pool, id, 4);
	}
	if (mech === "uniform") return me.missed ? (missed.length + 1) / 2 : null;
	if (mech === "t321") return t321Picks(teams, past).get(id) ?? null;
	if (mech === "classic" || mech === "waitlist") {
		if (!me.missed) return null;
		// The first four picks are drawn by tickets. The rest go in reverse order
		// of record under Classic COLA and in order of tickets under Waitlist COLA.
		const pool = missed.map((t) => ({ id: t.id, w: pri[t.id], key: mech === "classic" ? -t.rec : pri[t.id] }));
		return raffleThenOrder(pool, id, 4);
	}
	if (mech === "full") {
		if (!me.missed) return null;
		// Every pick is drawn by tickets, so a rival is drawn before this team with
		// a chance equal to its share of the two teams' tickets.
		let place = 1;
		for (const o of missed) {
			if (o.id === id) continue;
			const both = pri[o.id] + pri[id];
			place += both > 0 ? pri[o.id] / both : 0.5;
		}
		return place;
	}
	if (mech === "simple") return me.wonSeries ? null : simplePlace(teams, pri, id, pri[id], me.rec);
	if (mech === "countdown") return countdownPicks(teams, pri).get(id) ?? null;
	if (mech === "beckett") return beckettPick(teams, pri, id);
	throw new Error(`unknown mechanism ${mech}`);
}

// ---------------------------------------------------------------------------
// The two help measures, one season at a time
// ---------------------------------------------------------------------------

// The 14 teams that missed the playoffs, worst record first; null when the
// season has another number of them (the NBA before 2004-05 had 29 teams).
function missedByRecord(teams) {
	const missed = teams.filter((t) => t.missed).sort((a, b) => a.rec - b.rec);
	return missed.length === 14 ? missed : null;
}

// The reward for losing from each starting position in `ranks` (1 is the worst
// record among the 14 that missed the playoffs). An entry is null when the
// mechanism does not place that team.
function rewardsForLosing(mech, season, state, ranks) {
	const missed = missedByRecord(season.teams);
	if (!missed) return null;
	const pri = priorityOf(mech, season.teams, state);
	// Any record below the league's worst gives the same order; one game of an
	// 82-game season is the step abstract_table.js uses.
	const worse = { rec: missed[0].rec - 1 / SIM_GAMES, wins: missed[0].wins - 1 };
	return ranks.map((rank) => {
		const team = missed[rank - 1];
		const moved = season.teams.map((t) => (t.id === team.id ? { ...t, ...worse } : t));
		const before = expectedPick(mech, season.teams, pri, state.past, team.id);
		const after = expectedPick(mech, moved, priorityOf(mech, moved, state), state.past, team.id);
		return before == null || after == null ? null : before - after;
	});
}

function rewardForLosing(mech, season, state, rank = 5) {
	const rewards = rewardsForLosing(mech, season, state, [rank]);
	return rewards && rewards[0];
}

function helpForWaiting(mech, season, state, rank = 5) {
	const missed = missedByRecord(season.teams);
	if (!missed) return null;
	if (NO_CARRY_OVER.has(mech)) return 0;
	const pri = priorityOf(mech, season.teams, state);
	const team = missed.slice().sort((a, b) => pri[b.id] - pri[a.id] || b.rec - a.rec)[rank - 1];
	// The mechanism's pool: the teams whose priorities this team competes with.
	const pool = season.teams.filter((t) =>
		mech === "beckett" ? pri[t.id] >= 2 : TICKET_MECHS.has(mech) ? t.missed : !t.wonSeries,
	);
	const rivals = pool.length ? pool : season.teams;
	const top = Math.max(...rivals.map((t) => pri[t.id])) + (TICKET_MECHS.has(mech) ? TICKET_STEP : 1);
	const before = expectedPick(mech, season.teams, pri, state.past, team.id);
	const after = expectedPick(mech, season.teams, { ...pri, [team.id]: top }, state.past, team.id);
	return before == null || after == null ? null : before - after;
}

// ---------------------------------------------------------------------------
// Small statistics
// ---------------------------------------------------------------------------

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => {
	const m = mean(a);
	return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
// Two-sided 95% point of Student's t, for the two sample sizes the paper uses:
// 29 degrees of freedom (30 leagues) and 21 (22 real seasons).
const T975 = { 29: 2.045, 21: 2.08 };
function interval(a) {
	const t = T975[a.length - 1];
	if (t == null) throw new Error(`no t value for n = ${a.length}`);
	const m = mean(a);
	const half = (t * sd(a)) / Math.sqrt(a.length);
	return { mean: m, lo: m - half, hi: m + half, n: a.length };
}

module.exports = {
	SIM_GAMES,
	fromSim,
	fromReal,
	walk,
	waitLengths,
	longestWait,
	beckettCounts,
	t321Picks,
	countdownPicks,
	raffleThenOrder,
	priorityOf,
	expectedPick,
	rewardsForLosing,
	rewardForLosing,
	helpForWaiting,
	mean,
	sd,
	interval,
};
