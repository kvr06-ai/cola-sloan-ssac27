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
 *   series     playoff series it won, 0 to 4
 *   grows      false for a team that reached the playoffs without the play-in,
 *              whose Capped COLA stockpile does not grow (the top six seeds)
 *   playIn     true for a team that reached the playoffs through the play-in
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
 *   firstPickGains(mech, ...)  for the same team and the same drop, the change
 *                              in its chance of the first pick, in percentage
 *                              points. A positive value is a better chance.
 *   helpForWaiting(mech, ...)  draft places a team gains when its priority alone
 *                              rises to one step above the highest in its pool.
 *                              The team is the one with the `rank`-th highest
 *                              priority among the 14 that missed the playoffs.
 *                              A step is one season of waiting or 1,000 tickets,
 *                              or under Capped COLA the team's own wins this
 *                              season, up to the cap of 150 tickets.
 *                              Zero for a lottery in which nothing carries over.
 * Both help measures are expectations over the mechanism's drawing, computed
 * exactly for all ten mechanisms (expectedPick() below), so they carry no
 * sampling error:
 *   "old"        the 2019 to 2026 lottery     raffleThenOrder() enumerates its four drawn picks
 *   "uniform"    Equal-Odds Lottery           every pool team expects pick 7.5
 *   "t321"       3-2-1 as adopted             t321Picks() sums over every state of its drawing
 *   "classic"    Classic COLA                 raffleThenOrder(), tickets then record
 *   "waitlist"   Waitlist COLA                raffleThenOrder(), tickets then tickets
 *   "full"       Full-lottery COLA            closed form for a drawing of every pick
 *   "simple"     Simple COLA                  no drawing
 *   "countdown"  Countdown COLA               countdownPicks() follows each team through its drawing
 *   "beckett"    Beckett COLA                 raffleThenOrder(), entries then entries
 *   "capped"     Capped COLA                  cappedPicks() follows every set of drawn teams
 * firstPickChance() takes each team's chance of the first pick from the same
 * drawings, also exactly.
 *
 * Carry-over state comes from the league's own history, walked in order by
 * walk(): each team's wait under Simple COLA and Countdown COLA (seasons since
 * it last won a playoff series or received a top-three pick), its count under
 * Beckett COLA, its Capped COLA stockpile after each draft and whether it sits
 * out Capped COLA's next pool, and its picks in earlier drafts, which 3-2-1's
 * limits on repeat picks read. Tickets for the other ticket mechanisms come
 * from the run file itself.
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
// chances from the lowest score up (the driver's COUNTDOWN_POOL_TICKETS). With
// fewer than five teams left, the list loses its first entries, so the highest
// score left always holds 2: 5, 4, 3, 2 with four teams, 4, 3, 2 with three, and
// 3, 2 with two. Highley's post of 2026-03-19: "When there are fewer than five
// teams remaining, the least vulnerable team gets 2 tickets, then 3, and so on."
const COUNTDOWN_CHANCES = [6, 5, 4, 3, 2];

// One step of priority: a season of waiting, or the 1,000 tickets a team gains
// in a season without a playoff series win (Section 3 of the paper).
const TICKET_STEP = 1000;

const NO_CARRY_OVER = new Set(["old", "uniform", "t321"]);
const TICKET_MECHS = new Set(["classic", "waitlist", "full"]);

// Capped COLA (Highley, "Overcoming Inertia to Stop NBA Tanking", 2026-04-22;
// the driver's cappedDraftOrder and cappedAfterDraft). The cap, the number of
// picks drawn, and the share of its stockpile a team keeps: after a round-1
// loss (10% off for a team that came through the play-in, 20% off otherwise),
// after 0 to 4 series won, and after each of picks 1 to 5.
const CAPPED_MAX = 150;
const CAPPED_DRAWN = 5;
const CAPPED_KEEP_R1_PLAYIN = 0.9;
const CAPPED_KEEP_R1_DIRECT = 0.8;
const CAPPED_KEEP_BY_SERIES = [1, 0.6, 0.4, 0.2, 0];
const CAPPED_KEEP_BY_PICK = [0, 0.2, 0.4, 0.6, 0.8];
// Stockpiles are rounded to the cent after every step, as in the driver.
const toCent = (x) => Math.round(x * 100) / 100;

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
			series: Math.max(0, t.playoffRoundsWon),
			// Seeds are logged by Capped COLA runs only: seeds 1 to 6 reached the
			// playoffs directly, seeds 7 and 8 through the play-in.
			grows: !(t.seed != null && t.seed <= 6),
			playIn: t.seed != null && t.seed >= 7,
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
			series: t.seriesWon,
			// The data marks the play-in teams but gives seeds only for 2025-26. A
			// playoff team outside the play-in is a top-six seed from 2020-21 on;
			// before the play-in, every playoff team counts as one, as in the COLA
			// Explorer that produced the post's 2025 table.
			grows: !t.madePlayoffs || !!t.playInParticipant,
			playIn: !!t.playInAdvanced,
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

// Capped COLA tickets in the drawing: the stockpile after the last draft, plus
// this season's wins for a team that grows, up to the cap, less the round-1
// reduction for a team that lost in the first round.
function cappedTickets(teams, before) {
	const tickets = {};
	for (const t of teams) {
		const s0 = before[t.id] ?? 0;
		let s = t.grows ? toCent(Math.min(CAPPED_MAX, s0 + t.wins)) : s0;
		if (!t.missed && !t.wonSeries) s = toCent(s * (t.playIn ? CAPPED_KEEP_R1_PLAYIN : CAPPED_KEEP_R1_DIRECT));
		tickets[t.id] = s;
	}
	return tickets;
}

// Calls fn(season, state, index) for each season in order. The state holds, for
// that season's draft:
//   wait         each team's wait after the season's playoffs
//   count        each team's Beckett count after the season's playoffs
//   countBefore  the Beckett counts the season started with
//   cappedBefore each team's Capped COLA stockpile after the previous draft
//   past         each team's picks in earlier drafts, oldest first
// It also marks each team's cappedPool: true when the team is in Capped COLA's
// pool, with no series win this season or last and no top-five pick last
// season.
function walk(league, fn) {
	const wait = {};
	const past = {};
	let count = {};
	let cappedBefore = {};
	let cappedOut = new Set();
	league.forEach((season, index) => {
		for (const t of season.teams) wait[t.id] = t.wonSeries ? 0 : (wait[t.id] ?? 0) + 1;
		const countBefore = count;
		count = beckettCounts(season.teams, countBefore);
		for (const t of season.teams) t.cappedPool = !t.wonSeries && !cappedOut.has(t.id);
		fn(season, { wait, past, count, countBefore, cappedBefore }, index);
		const tickets = cappedTickets(season.teams, cappedBefore);
		cappedBefore = {};
		cappedOut = new Set();
		for (const t of season.teams) {
			let s = tickets[t.id];
			if ((t.pick ?? 99) <= CAPPED_DRAWN) {
				s = toCent(s * CAPPED_KEEP_BY_PICK[t.pick - 1]);
				cappedOut.add(t.id);
			}
			if (t.wonSeries) {
				s = toCent(s * CAPPED_KEEP_BY_SERIES[t.series]);
				cappedOut.add(t.id);
			}
			cappedBefore[t.id] = s;
		}
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

// Expected pick and chance of the first pick of every team in the 3-2-1 pool,
// as { picks, first }, two maps keyed by team id. The pool is the eight worst
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
// the counts gives each kind's expected picks and first-pick chance with no
// sampling. Every team of a kind expects the same pick.
function t321Drawing(teams, past) {
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
	const first = new Float64Array(kinds.length);
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
			if (pick === 1) first[k] += q;
			prob[code - step[k]] += q;
		}
	}
	const perTeam = (byKind) => new Map(pool.map((t, i) => [t.id, byKind[kindOf[i]] / kinds[kindOf[i]].size]));
	return { picks: perTeam(expected), first: perTeam(first) };
}

// Expected pick of every team in the 3-2-1 pool (t321Drawing()).
function t321Picks(teams, past) {
	return t321Drawing(teams, past).picks;
}

// ---------------------------------------------------------------------------
// The Countdown COLA drawing, exactly
// ---------------------------------------------------------------------------

// Expected pick and chance of the first pick of every team in Countdown COLA's
// pool, the teams without a series win, as { picks, first }. A team's score is
// its wait times its wins. The order is filled from the last pick to the
// first, and each step draws one team from the five
// lowest scores left, with chances 6, 5, 4, 3, 2 from the lowest up, or the
// last entries of that list when fewer than five are left. Ties on
// score go to the longer wait, then to more wins, as in the driver.
//
// Put the teams in score order, lowest first. A team joins the five lowest
// when all but four of the teams below it are placed. From then on, the only
// thing that matters to it is how many of the five sit below it: a draw from
// below moves it down one, a draw from above changes nothing for it, and its
// own draw places it. Following that count gives its expected pick exactly.
// The first pick goes to the team still left after every other is drawn.
function countdownDrawing(teams, wait) {
	const order = teams
		.filter((t) => !t.wonSeries)
		.map((t) => ({ id: t.id, score: wait[t.id] * t.wins, wait: wait[t.id], wins: t.wins }))
		.sort((a, b) => b.score - a.score || b.wait - a.wait || b.wins - a.wins)
		.reverse();
	const n = order.length;
	const width = COUNTDOWN_CHANCES.length;
	const picks = new Map();
	const first = new Map();
	order.forEach((team, position) => {
		// below[r] is the chance that r of the lowest scores left sit below this team.
		let below = new Array(width).fill(0);
		below[Math.min(position, width - 1)] = 1;
		let expected = 0;
		let chance = 0;
		for (let placed = Math.max(0, position - (width - 1)); placed < n; placed++) {
			const size = Math.min(width, n - placed);
			const offset = width - size; // fewer than five left: the highest still holds 2
			let total = 0;
			for (let k = 0; k < size; k++) total += COUNTDOWN_CHANCES[offset + k];
			const next = new Array(width).fill(0);
			let lower = 0; // chances held by the teams below this one
			for (let r = 0; r < size; r++) {
				const p = below[r];
				if (p > 0) {
					expected += ((p * COUNTDOWN_CHANCES[offset + r]) / total) * (n - placed);
					if (n - placed === 1) chance += (p * COUNTDOWN_CHANCES[offset + r]) / total;
					if (r > 0) next[r - 1] += (p * lower) / total;
					next[r] += (p * (total - lower - COUNTDOWN_CHANCES[offset + r])) / total;
				}
				lower += COUNTDOWN_CHANCES[offset + r];
			}
			below = next;
		}
		picks.set(team.id, expected);
		first.set(team.id, chance);
	});
	return { picks, first };
}

// Expected pick of every team in Countdown COLA's pool (countdownDrawing()).
function countdownPicks(teams, wait) {
	return countdownDrawing(teams, wait).picks;
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

// Chance that team `id` receives the first pick of the same drawing: its share
// of the weight. When no team holds any, the order by key decides, and a tie
// for the front is shared evenly.
function firstOfRaffle(pool, id) {
	const me = pool.find((t) => t.id === id);
	const total = pool.reduce((s, t) => s + Math.max(0, t.w), 0);
	if (total > 0) return Math.max(0, me.w) / total;
	const better = pool.filter((t) => t.key > me.key).length;
	const equal = pool.filter((t) => t.id !== id && t.key === me.key).length;
	return better === 0 ? 1 / (1 + equal) : 0;
}

// ---------------------------------------------------------------------------
// The Capped COLA drawing, exactly
// ---------------------------------------------------------------------------

// Expected pick of every team under Capped COLA, given each team's tickets. The
// pool is the teams walk() marks with cappedPool. The first five picks are
// drawn from the pool in proportion to tickets; a team without tickets is never
// drawn, and the drawing ends early if no team left holds any. The rest of the
// pool follows by tickets, then wins, and the teams outside the pool follow it
// in the same order. A tie on both is settled arbitrarily, so it counts as half
// a place, as in raffleThenOrder().
//
// The chance of drawing a team next depends only on which teams are already
// drawn, so the drawing is followed through every set of up to five drawn
// teams, each held as a bit mask with its chance. That gives each team's
// chance at each drawn pick and the chance of every set the drawing ends on,
// which places the teams left undrawn. Nothing is sampled. The last result for
// each tickets object is kept, since rewardsForLosing() asks for the same
// season's baseline once per starting position.
const cappedCache = new WeakMap();
function cappedPicks(teams, tickets) {
	const hit = cappedCache.get(tickets);
	if (hit && hit.teams === teams) return hit.picks;
	const above = (a, b) => tickets[a.id] > tickets[b.id] || (tickets[a.id] === tickets[b.id] && a.wins > b.wins);
	const level = (a, b) => tickets[a.id] === tickets[b.id] && a.wins === b.wins;
	const pool = teams.filter((t) => t.cappedPool);
	const outside = teams.filter((t) => !t.cappedPool);
	const n = pool.length;
	const w = pool.map((t) => Math.max(0, tickets[t.id]));
	// aboveAll[i] and levelAll[i] count the pool teams ahead of and level with i.
	const aboveOf = pool.map((a) => pool.map((b) => above(a, b)));
	const levelOf = pool.map((a, i) => pool.map((b, j) => i !== j && level(a, b)));
	const aboveAll = pool.map((_, i) => aboveOf.reduce((s, row) => s + (row[i] ? 1 : 0), 0));
	const levelAll = pool.map((_, i) => levelOf.reduce((s, row) => s + (row[i] ? 1 : 0), 0));
	const expected = new Float64Array(n);
	let sets = new Map([[0, 1]]);
	for (let drawn = 0; sets.size > 0; drawn++) {
		const next = new Map();
		for (const [mask, p] of sets) {
			let left = 0;
			const members = [];
			for (let i = 0; i < n; i++) {
				if (mask & (1 << i)) members.push(i);
				else left += w[i];
			}
			if (drawn === CAPPED_DRAWN || left <= 0) {
				// The drawing ends here: the undrawn pool teams follow in order.
				for (let i = 0; i < n; i++) {
					if (mask & (1 << i)) continue;
					let ahead = aboveAll[i];
					let tied = levelAll[i];
					for (const d of members) {
						if (aboveOf[d][i]) ahead--;
						if (levelOf[d][i]) tied--;
					}
					expected[i] += p * (drawn + 1 + ahead + tied / 2);
				}
				continue;
			}
			for (let i = 0; i < n; i++) {
				if (mask & (1 << i) || w[i] <= 0) continue;
				const q = (p * w[i]) / left;
				expected[i] += q * (drawn + 1);
				const m = mask | (1 << i);
				next.set(m, (next.get(m) ?? 0) + q);
			}
		}
		sets = next;
	}
	const picks = new Map(pool.map((t, i) => [t.id, expected[i]]));
	for (const t of outside) {
		let ahead = 0;
		let tied = 0;
		for (const o of outside) {
			if (o === t) continue;
			if (above(o, t)) ahead++;
			else if (level(o, t)) tied++;
		}
		picks.set(t.id, n + 1 + ahead + tied / 2);
	}
	cappedCache.set(tickets, { teams, picks });
	return picks;
}

// Chance that team `id` receives the first pick under Capped COLA: its share of
// the pool's tickets. If no pool team holds any, the first pick goes by tickets
// and then wins, as in cappedPicks(), to the pool or, when the pool is empty,
// to the teams outside it. A tie for the front is shared evenly.
function cappedFirst(teams, tickets, id) {
	const me = teams.find((t) => t.id === id);
	const above = (a, b) => tickets[a.id] > tickets[b.id] || (tickets[a.id] === tickets[b.id] && a.wins > b.wins);
	const level = (a, b) => tickets[a.id] === tickets[b.id] && a.wins === b.wins;
	const lead = (group) => {
		const ahead = group.filter((o) => o.id !== id && above(o, me)).length;
		const tied = group.filter((o) => o.id !== id && level(o, me)).length;
		return ahead === 0 ? 1 / (1 + tied) : 0;
	};
	const pool = teams.filter((t) => t.cappedPool);
	const total = pool.reduce((s, t) => s + Math.max(0, tickets[t.id]), 0);
	if (me.cappedPool) return total > 0 ? Math.max(0, tickets[id]) / total : lead(pool);
	return pool.length > 0 ? 0 : lead(teams.filter((t) => !t.cappedPool));
}

// ---------------------------------------------------------------------------
// Expected pick of one team under each mechanism
// ---------------------------------------------------------------------------

// Simple COLA: the teams ahead of and level with team `id` in the pool of teams
// without a series win, ordered by longest wait and then by better record.
function simpleRank(teams, wait, id, myWait, myRec) {
	let ahead = 0;
	let tied = 0;
	for (const o of teams) {
		if (o.id === id || o.wonSeries) continue;
		if (wait[o.id] > myWait || (wait[o.id] === myWait && o.rec > myRec)) ahead++;
		else if (wait[o.id] === myWait && o.rec === myRec) tied++;
	}
	return { ahead, tied };
}

// Simple COLA: place in that pool. A tie on both wait and record is settled by
// a coin flip, so it counts as half a place.
function simplePlace(teams, wait, id, myWait, myRec) {
	const { ahead, tied } = simpleRank(teams, wait, id, myWait, myRec);
	return 1 + ahead + tied / 2;
}

// Beckett COLA: the pool is every team with a count of two or more. Entries are
// count times wins. The first four picks are drawn by entries and the rest of
// the pool follows in order of entries. A team that missed the playoffs and is
// outside the pool picks after it, worst record first. beckettOrder() returns
// the pool and, for a team outside it, the teams ahead of and level with it
// there, or null when the mechanism does not place the team.
function beckettOrder(teams, count, id) {
	const me = teams.find((t) => t.id === id);
	const pool = teams
		.filter((t) => count[t.id] >= 2)
		.map((t) => ({ id: t.id, w: count[t.id] * t.wins, key: count[t.id] * t.wins }));
	if (count[id] >= 2) return { pool, inPool: true };
	if (!me.missed) return null;
	let ahead = 0;
	let tied = 0;
	for (const o of teams) {
		if (o.id === id || count[o.id] >= 2 || !o.missed) continue;
		if (o.wins < me.wins) ahead++;
		else if (o.wins === me.wins) tied++;
	}
	return { pool, inPool: false, ahead, tied };
}

function beckettPick(teams, count, id) {
	const o = beckettOrder(teams, count, id);
	if (!o) return null;
	return o.inPool ? raffleThenOrder(o.pool, id, 4) : o.pool.length + 1 + o.ahead + o.tied / 2;
}

// Beckett COLA's chance of the first pick. A team outside the pool can receive
// it only when the pool is empty, as in a simulated league's first season.
function beckettFirst(teams, count, id) {
	const o = beckettOrder(teams, count, id);
	if (!o) return null;
	if (o.inPool) return firstOfRaffle(o.pool, id);
	return o.pool.length === 0 && o.ahead === 0 ? 1 / (1 + o.tied) : 0;
}

// The priority each mechanism carries over, for every team in a season.
function priorityOf(mech, teams, state) {
	if (mech === "simple" || mech === "countdown") return state.wait;
	if (mech === "beckett") return beckettCounts(teams, state.countBefore);
	if (TICKET_MECHS.has(mech)) return Object.fromEntries(teams.map((t) => [t.id, t.tickets ?? 0]));
	// Capped COLA's tickets follow from this season's wins, so a worse record
	// also costs a team tickets.
	if (mech === "capped") return cappedTickets(teams, state.cappedBefore);
	return {};
}

// The Old Lottery's pool. Chances follow the rank by record, worst first, and
// the order after the drawing is reverse order of record.
function oldPool(missed) {
	return missed
		.slice()
		.sort((a, b) => a.rec - b.rec)
		.map((t, i) => ({ id: t.id, w: NBA_BALLS[i] ?? NBA_BALLS.at(-1), key: -t.rec }));
}

// Classic and Waitlist COLA's pool. The drawing is by tickets. The order after
// it is reverse order of record under Classic COLA and order of tickets under
// Waitlist COLA.
function ticketPool(mech, missed, pri) {
	return missed.map((t) => ({ id: t.id, w: pri[t.id], key: mech === "classic" ? -t.rec : pri[t.id] }));
}

// Expected pick of team `id` this season, or null if the mechanism does not
// place it. `pri` is the priority of every team (priorityOf), which a caller
// may alter for one team; `past` holds every team's earlier picks.
function expectedPick(mech, teams, pri, past, id) {
	const me = teams.find((t) => t.id === id);
	const missed = teams.filter((t) => t.missed);
	if (mech === "old") {
		if (!me.missed) return null;
		// The first four picks are drawn and the rest go in reverse order of record.
		return raffleThenOrder(oldPool(missed), id, 4);
	}
	if (mech === "uniform") return me.missed ? (missed.length + 1) / 2 : null;
	if (mech === "t321") return t321Picks(teams, past).get(id) ?? null;
	if (mech === "classic" || mech === "waitlist") {
		if (!me.missed) return null;
		// The first four picks are drawn by tickets.
		return raffleThenOrder(ticketPool(mech, missed, pri), id, 4);
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
	if (mech === "capped") return cappedPicks(teams, pri).get(id) ?? null;
	throw new Error(`unknown mechanism ${mech}`);
}

// Chance that team `id` receives the first pick this season, from the same
// drawing as expectedPick() and with the same arguments, or null if the
// mechanism does not place the team. With no drawing, the team at the front
// of the order has the first pick, and a tie for the front is shared evenly.
function firstPickChance(mech, teams, pri, past, id) {
	const me = teams.find((t) => t.id === id);
	const missed = teams.filter((t) => t.missed);
	if (mech === "old") return me.missed ? firstOfRaffle(oldPool(missed), id) : null;
	if (mech === "uniform") return me.missed ? 1 / missed.length : null;
	if (mech === "t321") return t321Drawing(teams, past).first.get(id) ?? null;
	if (mech === "classic" || mech === "waitlist") return me.missed ? firstOfRaffle(ticketPool(mech, missed, pri), id) : null;
	if (mech === "full") {
		if (!me.missed) return null;
		// With no tickets in the pool, every order is equally likely, as in
		// expectedPick().
		const total = missed.reduce((s, t) => s + pri[t.id], 0);
		return total > 0 ? pri[id] / total : 1 / missed.length;
	}
	if (mech === "simple") {
		if (me.wonSeries) return null;
		const { ahead, tied } = simpleRank(teams, pri, id, pri[id], me.rec);
		return ahead === 0 ? 1 / (1 + tied) : 0;
	}
	if (mech === "countdown") return countdownDrawing(teams, pri).first.get(id) ?? null;
	if (mech === "beckett") return beckettFirst(teams, pri, id);
	if (mech === "capped") return cappedFirst(teams, pri, id);
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

// The team at each starting position in `ranks` (1 is the worst record among
// the 14 that missed the playoffs) drops alone to the worst record in the
// league. For each, `value` (expectedPick or firstPickChance) is read before and
// after the drop, and `change(before, after)` is returned, or null when the
// mechanism does not place that team.
function dropToWorst(mech, season, state, ranks, value, change) {
	const missed = missedByRecord(season.teams);
	if (!missed) return null;
	const pri = priorityOf(mech, season.teams, state);
	// Any record below the league's worst gives the same order; one game of an
	// 82-game season is the step abstract_table.js uses.
	const worse = { rec: missed[0].rec - 1 / SIM_GAMES, wins: missed[0].wins - 1 };
	return ranks.map((rank) => {
		const team = missed[rank - 1];
		const moved = season.teams.map((t) => (t.id === team.id ? { ...t, ...worse } : t));
		const before = value(mech, season.teams, pri, state.past, team.id);
		const after = value(mech, moved, priorityOf(mech, moved, state), state.past, team.id);
		return before == null || after == null ? null : change(before, after);
	});
}

// The reward for losing from each starting position: draft places gained.
function rewardsForLosing(mech, season, state, ranks) {
	return dropToWorst(mech, season, state, ranks, expectedPick, (before, after) => before - after);
}

// The change in the chance of the first pick from each starting position, in
// percentage points.
function firstPickGains(mech, season, state, ranks) {
	return dropToWorst(mech, season, state, ranks, firstPickChance, (before, after) => 100 * (after - before));
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
		mech === "beckett" ? pri[t.id] >= 2 : mech === "capped" ? t.cappedPool : TICKET_MECHS.has(mech) ? t.missed : !t.wonSeries,
	);
	const rivals = pool.length ? pool : season.teams;
	const highest = Math.max(...rivals.map((t) => pri[t.id]));
	// Under Capped COLA a step is the team's own wins, one season's growth, and
	// no stockpile passes the cap.
	const top = mech === "capped" ? Math.min(CAPPED_MAX, highest + team.wins) : highest + (TICKET_MECHS.has(mech) ? TICKET_STEP : 1);
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
	cappedTickets,
	cappedPicks,
	raffleThenOrder,
	priorityOf,
	expectedPick,
	firstPickChance,
	rewardsForLosing,
	rewardForLosing,
	firstPickGains,
	helpForWaiting,
	mean,
	sd,
	interval,
};
