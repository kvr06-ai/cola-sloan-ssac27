// Full-engine COLA sweep driver -- SCAFFOLD (step 1 of the tactical plan).
//
// Proves the phase-stepping season loop + dial hook + per-season pruning work
// end-to-end for one grid config against the REAL ZenGM engine (real rosters /
// contracts / AI GMs / per-game sim), not the synthesized Track B testbed.
// This de-risks the lottery-boundary intercept before the full driver (all
// dials + Countdown/Beckett anchors + objectives + sweep wiring) is built.
//
// Design (see collab doc "Full-engine driver: tactical execution plan"):
//   - Drive the season by phase-stepping (a synchronous, fully-awaited version
//     of autoPlay), NOT autoPlayUntil (which self-drives past the hook and
//     detaches promises).
//   - game.play() auto-advances phases at schedule exhaustion (reg-season ->
//     PLAYOFFS, playoffs -> DRAFT_LOTTERY). The PLAYOFFS->DRAFT_LOTTERY
//     transition runs the engine's own cola.updateLotteryChancesAfterPlayoffs()
//     internally.
//   - Two hook points bracket the cola update:
//       Hook A @ PRESEASON    : carry-over scope (dial S), BEFORE the season so
//                               the reset precedes the increment.
//       Hook B @ DRAFT_LOTTERY: eligibility mask (dial E) + cap clamp (dial C),
//                               AFTER updateLotteryChancesAfterPlayoffs (which
//                               already incremented every non-advancing team,
//                               R1 losers included) and BEFORE the draw.
//     NB: masking AFTER the cola update corrects a latent Track B ordering bug
//     (Track B masked R1 losers BEFORE the update, which re-incremented them
//     straight back into the pool).
//   - Spectator mode hands every roster to the AI; without it game.play()
//     no-ops once the unmanaged user roster underflows (play.ts:614+).
//   - Per-season pruning drops retired players from the cache (the working set
//     the engine iterates) so sec/season stays flat over a 30-season run.
//
// Run: COLA_SPIKE=1 npx vitest --run src/test/colaFullEngineDriver.test.ts --project basketball
//   COLA_DRIVER_SEASONS=N    seasons to run (default 3)
//   COLA_DRIVER_NOPRUNE=1    disable pruning (to measure the drift it removes)

import "fake-indexeddb/auto";
import * as fs from "node:fs";
import { afterAll, expect, test } from "vitest";
import { draft, freeAgents, game, league, phase, season } from "../worker/core/index.ts";
import { idb } from "../worker/db/index.ts";
import { g, helpers, local } from "../worker/util/index.ts";
import "../worker/index.ts";
import createStreamFromLeagueObject from "../worker/core/league/create/createStreamFromLeagueObject.ts";
import { LEAGUE_DATABASE_VERSION, PHASE, PLAYER } from "../common/constants.ts";
import { getDefaultSettings } from "../worker/views/newLeague.ts";
import { last } from "../common/utils.ts";
import { defaultGameAttributes } from "../common/defaultGameAttributes.ts";

type Config = {
	id: number;
	E: number | "16-tiered";
	C: number | null;
	S: "single-season" | "unbounded" | "bounded-30yr" | "reset-on-championship";
	seasons: number;
	// Off-grid named mechanisms. When set, E/C/S are ignored and the draft order
	// is computed driver-side and injected over the engine's lottery. "countdown"
	// and "beckett" are the named anchors; "random" assigns a uniform random
	// permutation of picks across all teams (the draft-to-outcome channel probe,
	// and the uniform-lottery baseline for the equity leg); "weighted" draws the
	// full draft order over the eligible pool by cola^gamma (the W dial family).
	variant?: "countdown" | "beckett" | "random" | "weighted" | "nba" | "t321";
	// Weighting exponent for the "weighted" variant (0 = flat among eligible,
	// 1 = proportional to the multi-year index, >1 = steep). Distinct from
	// COLA_ALPHA, the per-season increment. Ignored for other variants.
	gamma?: number;
	// Lottery depth for the "weighted" variant. Undefined (default) = full-depth
	// lottery (every pool pick drawn at random by cola^gamma). A finite value
	// (e.g. 4) is the MIDDLE OPTION: draw the top `lotteryDepth` picks at random,
	// then order the rest of the pool deterministically by index (cola DESC), so
	// picks past the depth go by drought, not record -- closing the same tanking
	// tail full-depth closes while keeping a top-`lotteryDepth` lottery. Ignored
	// for other variants.
	lotteryDepth?: number;
	// Draw depth for the "t321" variant: how many top picks the tiered-ball
	// draw assigns before the remainder falls back to record order. 4 = an
	// NBA-style top-four lottery over the tiered balls; 16 = the full pool
	// drawn by balls. The public 3-2-1 description does not pin this down,
	// so the sweep runs both. Ignored for other variants ("nba" is always 4).
	drawDepth?: number;
};

type TeamRec = {
	tid: number;
	conf: "E" | "W";
	wins: number;
	playoffRoundsWon: number;
	draftPick: number | null;
	cola: number;
	// Pre-draw lottery index L_i (post-playoff-update, before the lottery decay):
	// the index the draw weights on, used by the pool-manipulation analysis.
	colaPre: number;
	// Roster-strength proxy: mean of the team's top-8 players' current ovr. A
	// lower-noise outcome than wins for the draft-to-outcome channel probe.
	rosterOvr: number;
};
type SeasonRec = {
	season: number;
	elapsedSecs: number;
	cachePlayers: number;
	teams: TeamRec[];
};

const NO_COND = {};
const PRUNE = !process.env.COLA_DRIVER_NOPRUNE;

// --- Dial transforms (ported from Track B, with corrected ordering) ---------

// Hook A: carry-over scope. Applied at PRESEASON, before the season runs.
async function applyCarryOverScope(
	S: Config["S"],
	priorChampionTid: number | null,
) {
	if (S === "unbounded") return; // engine default: cola carries over as-is
	const teams = await idb.cache.teams.getAll();
	if (S === "single-season") {
		for (const t of teams) {
			t.cola = 0;
			await idb.cache.teams.put(t);
		}
		return;
	}
	if (S === "reset-on-championship") {
		if (priorChampionTid === null) return;
		for (const t of teams) {
			if (t.tid === priorChampionTid) {
				t.cola = 0;
				await idb.cache.teams.put(t);
			}
		}
		return;
	}
	// bounded-30yr: for a 30-season run this is IDENTICAL to unbounded -- no
	// cola contribution is ever older than the 30-year window, so the window
	// never binds. It would only differ for >30-season horizons, which the
	// sweep does not run. Intentional no-op (documented in ASSUMPTIONS).
}

// Hook B (part 1): eligibility mask. Applied at DRAFT_LOTTERY, AFTER the cola
// update, BEFORE the draw. Zeros cola for teams outside the pool so the lottery
// draw skips them (cola=0 -> zero chance -> falls through to rank order).
async function applyEligibilityMask(
	E: Config["E"],
	seasonTeamSeasons: { tid: number; playoffRoundsWon: number; won: number; cid: number }[],
) {
	if (E === 22) return; // engine default pool (14 non-playoff + 8 R1 losers)
	const teams = await idb.cache.teams.getAll();
	if (E === 14) {
		// R1 losers (made playoffs, won 0 rounds) drop out; the 14 non-playoff
		// teams (playoffRoundsWon < 0) stay.
		for (const ts of seasonTeamSeasons) {
			if (ts.playoffRoundsWon === 0) {
				const t = teams.find((x) => x.tid === ts.tid);
				if (t) {
					t.cola = 0;
					await idb.cache.teams.put(t);
				}
			}
		}
		return;
	}
	if (E === "16-tiered") {
		// 3-2-1 proposal pool, per conference: the bottom 8 by record (seeds
		// 8-15) in each conference = 10 non-playoff-non-play-in (seeds 11-15) +
		// 4 record-9/10 (seeds 9-10) + 2 7v8-losers (proxied by the 8-seed).
		// This is the per-conference 3-2-1 structure -- more faithful than Track
		// B's "16 worst overall" -- using only regular-season record. The exact
		// 7v8-game loser (vs the 8-seed proxy) would come from
		// playoffSeries.playIns; that refinement is a 2-team, play-in-upset-only
		// difference (the engine has the data; documented in ASSUMPTIONS).
		const byConf: Record<number, typeof seasonTeamSeasons> = {};
		for (const ts of seasonTeamSeasons) (byConf[ts.cid] ??= []).push(ts);
		const eligible = new Set<number>();
		for (const cid of Object.keys(byConf)) {
			byConf[Number(cid)]!
				.slice()
				.sort((a, b) => a.won - b.won)
				.slice(0, 8)
				.forEach((ts) => eligible.add(ts.tid));
		}
		for (const t of teams) {
			if (!eligible.has(t.tid)) {
				t.cola = 0;
				await idb.cache.teams.put(t);
			}
		}
	}
}

// Hook B (part 2): cap clamp. Applied at DRAFT_LOTTERY, after the eligibility
// mask, before the draw.
async function applyCapClamp(C: Config["C"]) {
	if (C === null) return;
	const teams = await idb.cache.teams.getAll();
	for (const t of teams) {
		if (t.cola !== undefined && t.cola > C) {
			t.cola = C;
			await idb.cache.teams.put(t);
		}
	}
}

// Per-season prune. Box scores accumulate ~1230/season and the event log grows
// continuously; both pile up in idb.league (fake-indexeddb RAM) and the sweep
// never reads either, so clearing them each season bounds RAM over a long run
// (this is deleteOldData's boxScores + events). Box scores are not retained in
// the cache, so they are cleared from the league directly; events are cached,
// so clearing them through the cache API propagates on the next flush.
// (Retired players are NOT cache-resident -- tid -3 lives only in idb.league --
// so they are left alone; they are tiny and not the working set the per-game
// sim iterates. The residual ~1s/season drift is idb.league query cost from
// accumulating player-stats rows; trimming those is the pilot's tuning target,
// task #67.)
async function pruneSeasonData(): Promise<void> {
	try {
		await idb.cache.events.clear();
	} catch {}
	try {
		const tx = idb.league.transaction("games", "readwrite");
		await tx.objectStore("games").clear();
		await tx.done;
	} catch {}
	// Retired players (tid -3) are NOT cache-resident -- they accumulate only in
	// idb.league (~12/season, each with full career stats), and the per-game sim
	// never reads them. Deleting them from the league store is safe and attacks
	// the idb.league-size growth behind the residual sec/season drift
	// (deleteOldData's retiredPlayers option). COLA_NO_RETIRE_PRUNE measures the
	// effect against the box-score/event-only baseline.
	if (!process.env.COLA_NO_RETIRE_PRUNE) {
		try {
			const tx = idb.league.transaction("players", "readwrite");
			for await (const cursor of tx
				.objectStore("players")
				.index("tid")
				.iterate(PLAYER.RETIRED)) {
				await cursor.delete();
			}
			await tx.done;
		} catch {}
	}
}

// --- League construction ----------------------------------------------------

async function createColaLeague(startSeason: number) {
	const settings = { ...getDefaultSettings(), draftType: "cola" as const };
	await league.createStream(createStreamFromLeagueObject({}), {
		confs: last(defaultGameAttributes.confs).value,
		divs: last(defaultGameAttributes.divs).value,
		fromFile: {
			gameAttributes: undefined,
			hasRookieContracts: true,
			maxGid: undefined,
			startingSeason: undefined,
			teams: undefined,
			version: LEAGUE_DATABASE_VERSION,
		},
		getLeagueOptions: undefined,
		keptKeys: new Set<any>(),
		lid: 0,
		name: "ColaFullEngine",
		setLeagueCreationStatus: () => {},
		settings,
		shuffleRosters: false,
		startingSeasonFromInput: String(startSeason),
		teamsFromInput: helpers.addPopRank(helpers.getTeamsDefault()),
		tid: 0,
	} as any);

	// Spectator mode: no human-managed team, so the AI fills/resigns every
	// roster (incl. tid 0) during resign + free agency. Without this,
	// team.checkRosterSizes("user") raises a blocking error once tid 0's roster
	// underflows and game.play() silently no-ops (play.ts:614+). This is the
	// headless-sweep equivalent of autoPlayUntil.
	g.setWithoutSavingToDB("spectator", true);
}

// --- Season capture (at the draft, when cola + lottery order are fresh) ------

async function captureSeasonRecord(
	seasonNow: number,
	colaPreByTid: Record<number, number> = {},
): Promise<TeamRec[]> {
	const tss = (await idb.cache.teamSeasons.getAll()).filter(
		(ts: any) => ts.season === seasonNow,
	);
	const teams = await idb.cache.teams.getAll();
	const dps = await idb.cache.draftPicks.getAll();
	const pickByTid: Record<number, number> = {};
	for (const dp of dps as any[]) {
		if (dp.season === seasonNow && dp.round === 1) {
			pickByTid[dp.originalTid ?? dp.tid] = dp.pick;
		}
	}
	// Roster-strength proxy: mean of the top-8 players' current ovr per team.
	// ratings.ovr is precomputed by develop() each season, so the latest ratings
	// row carries the post-season ovr. This is the team that produced this
	// season's wins (captured at DRAFT_LOTTERY, before the draft/FA reshuffle).
	const players = await idb.cache.players.getAll();
	const ovrsByTid: Record<number, number[]> = {};
	for (const p of players as any[]) {
		if (p.tid < 0) continue; // skip FA (-1), retired (-3), prospects (-2)
		const r = p.ratings[p.ratings.length - 1];
		if (!r || typeof r.ovr !== "number") continue;
		(ovrsByTid[p.tid] ??= []).push(r.ovr);
	}
	const rosterOvrByTid: Record<number, number> = {};
	for (const tidKey of Object.keys(ovrsByTid)) {
		const top = ovrsByTid[Number(tidKey)]!
			.slice()
			.sort((a, b) => b - a)
			.slice(0, 8);
		rosterOvrByTid[Number(tidKey)] = top.length
			? Number((top.reduce((a, b) => a + b, 0) / top.length).toFixed(2))
			: 0;
	}
	return tss.map((ts: any) => {
		const t = teams.find((x: any) => x.tid === ts.tid);
		return {
			tid: ts.tid,
			conf: (t?.cid ?? ts.cid) === 0 ? ("E" as const) : ("W" as const),
			wins: ts.won,
			playoffRoundsWon: ts.playoffRoundsWon,
			draftPick: pickByTid[ts.tid] ?? null,
			cola: t?.cola ?? 0,
			colaPre: colaPreByTid[ts.tid] ?? (t?.cola ?? 0),
			rosterOvr: rosterOvrByTid[ts.tid] ?? 0,
		};
	});
}

// --- Named anchors (Countdown, Beckett): non-cola mechanisms ----------------
// These compute a full draft order driver-side and inject it (override the
// engine's lottery order). Drought is tracked across seasons by the driver.
//   Countdown: drought = years since a playoff series win OR top-3 pick;
//     McCarty number = drought x wins; survivor-style elimination-pool draw
//     (5-team pools, tickets 6..2 worst..best). Eligible = seriesWon === 0.
//     Source: docs/js/cola-engine.js computeCountdownCOLA / countdownTrial.
//   Beckett: drought = years since a #1 pick OR top-6 seed OR playoff series
//     win; eligible = drought >= 2; entries = drought x wins; top-4 raffled by
//     entries, rest by entries DESC. Uncapped (cap pending Highley).
//     Source: Highley & Sanderson Substack 2026-04-10.

type AnchorTeam = { tid: number; wins: number; playoffRoundsWon: number; cid: number };

const COUNTDOWN_POOL_TICKETS = [6, 5, 4, 3, 2];

// Port of cola-engine.js countdownTrial: one survivor-style draw over the
// McCarty-ranked eligible pool. Uses the (seeded) Math.random stream.
function countdownTrial(rankedTids: number[]): Record<number, number> {
	const remaining = [...rankedTids].reverse(); // index 0 = worst McCarty
	const assignment: Record<number, number> = {};
	const total = remaining.length;
	for (let pick = total; pick >= 1; pick--) {
		if (remaining.length === 1) {
			assignment[remaining[0]!] = pick;
			break;
		}
		const poolSize = Math.min(5, remaining.length);
		const tickets = COUNTDOWN_POOL_TICKETS.slice(0, poolSize);
		const ticketTotal = tickets.reduce((a, b) => a + b, 0);
		const roll = Math.random() * ticketTotal;
		let cumulative = 0;
		let drawn = 0;
		for (let i = 0; i < poolSize; i++) {
			cumulative += tickets[i]!;
			if (roll < cumulative) {
				drawn = i;
				break;
			}
		}
		assignment[remaining[drawn]!] = pick;
		remaining.splice(drawn, 1);
	}
	return assignment;
}

// Beckett: top-4 weighted raffle (by entries, without replacement), rest by
// entries DESC.
function beckettDraw(eligible: { tid: number; entries: number }[]): Record<number, number> {
	const pool = eligible.slice();
	const assignment: Record<number, number> = {};
	const nRaffle = Math.min(4, pool.length);
	for (let pick = 1; pick <= nRaffle; pick++) {
		const total = pool.reduce((a, t) => a + Math.max(0, t.entries), 0);
		let idx = 0;
		if (total > 0) {
			const roll = Math.random() * total;
			let cum = 0;
			for (let i = 0; i < pool.length; i++) {
				cum += Math.max(0, pool[i]!.entries);
				if (roll < cum) {
					idx = i;
					break;
				}
			}
		}
		assignment[pool[idx]!.tid] = pick;
		pool.splice(idx, 1);
	}
	pool.sort((a, b) => b.entries - a.entries);
	let pick = nRaffle + 1;
	for (const t of pool) assignment[t.tid] = pick++;
	return assignment;
}

// Top-6-by-wins within each conference (proxy for "top-6 seed", which excludes
// play-in teams). Used by Beckett's drought reset.
function top6ByConf(tss: AnchorTeam[]): Set<number> {
	const byConf: Record<number, AnchorTeam[]> = {};
	for (const ts of tss) (byConf[ts.cid] ??= []).push(ts);
	const top6 = new Set<number>();
	for (const cid of Object.keys(byConf)) {
		byConf[Number(cid)]!
			.slice()
			.sort((a, b) => b.wins - a.wins)
			.slice(0, 6)
			.forEach((ts) => top6.add(ts.tid));
	}
	return top6;
}

// Compute the full round-1 draft order (tid -> pick) for an anchor variant.
// Updates droughtState in place (Phase A: post-playoff, pre-draft). Phase B
// (post-draft pick reset) is applied by the caller after injection.
function computeAnchorOrder(
	variant: "countdown" | "beckett",
	tss: AnchorTeam[],
	droughtState: Record<number, number>,
): Record<number, number> {
	// Phase A drought update.
	const top6 = variant === "beckett" ? top6ByConf(tss) : null;
	for (const ts of tss) {
		const wonSeries = ts.playoffRoundsWon >= 1;
		const reset =
			variant === "countdown"
				? wonSeries
				: wonSeries || top6!.has(ts.tid); // #1-pick reset is Phase B
		droughtState[ts.tid] = reset ? 0 : (droughtState[ts.tid] ?? 0) + 1;
	}

	let assignment: Record<number, number>;
	if (variant === "countdown") {
		// Eligible = no playoff series win (14 non-playoff + 8 R1 losers).
		const eligible = tss
			.filter((ts) => ts.playoffRoundsWon < 1)
			.map((ts) => ({
				tid: ts.tid,
				mccarty: (droughtState[ts.tid] ?? 0) * ts.wins,
				drought: droughtState[ts.tid] ?? 0,
				wins: ts.wins,
			}))
			.sort(
				(a, b) =>
					b.mccarty - a.mccarty || b.drought - a.drought || b.wins - a.wins,
			);
		assignment = countdownTrial(eligible.map((e) => e.tid));
	} else {
		const eligible = tss
			.filter((ts) => (droughtState[ts.tid] ?? 0) >= 2)
			.map((ts) => ({ tid: ts.tid, entries: (droughtState[ts.tid] ?? 0) * ts.wins }));
		assignment = beckettDraw(eligible);
	}

	// Non-eligible teams pick after the pool, worst playoff finish / record first.
	const eligibleSet = new Set(Object.keys(assignment).map(Number));
	const tail = tss
		.filter((ts) => !eligibleSet.has(ts.tid))
		.sort((a, b) => a.playoffRoundsWon - b.playoffRoundsWon || a.wins - b.wins);
	let next = eligibleSet.size + 1;
	for (const ts of tail) assignment[ts.tid] = next++;
	return assignment;
}

// Overwrite the engine's round-1 pick numbers with the anchor order.
async function injectDraftOrder(
	seasonNow: number,
	tidToPick: Record<number, number>,
) {
	const dps = await idb.cache.draftPicks.getAll();
	for (const dp of dps as any[]) {
		if (dp.season === seasonNow && dp.round === 1) {
			const pick = tidToPick[dp.originalTid ?? dp.tid];
			if (pick !== undefined) {
				dp.pick = pick;
				await idb.cache.draftPicks.put(dp);
			}
		}
	}
}

// --- Phase-stepping driver --------------------------------------------------

async function runConfig(config: Config): Promise<SeasonRec[]> {
	const START = 2025;
	await createColaLeague(START);

	const records: SeasonRec[] = [];
	const droughtState: Record<number, number> = {}; // anchors only
	let pendingTeams: TeamRec[] | null = null;
	let pendingSeason = START;
	let priorChampionTid: number | null = null;
	let seasonStart = Date.now();
	let guard = 0;
	const guardMax = config.seasons * 25 + 50;

	while (records.length < config.seasons && guard < guardMax) {
		guard += 1;
		const ph = g.get("phase");

		if (ph === PHASE.PRESEASON) {
			if (!config.variant) {
				await applyCarryOverScope(config.S, priorChampionTid); // Hook A (cola only)
			}
			await phase.newPhase(PHASE.REGULAR_SEASON, NO_COND);
		} else if (
			ph === PHASE.REGULAR_SEASON ||
			ph === PHASE.AFTER_TRADE_DEADLINE
		) {
			await game.play(await season.getDaysLeftSchedule(), NO_COND);
		} else if (ph === PHASE.PLAYOFFS) {
			await game.play(100, NO_COND);
		} else if (ph === PHASE.DRAFT_LOTTERY) {
			pendingSeason = g.get("season");
			const teamsNow = await idb.cache.teams.getAll();
			const tss = (await idb.cache.teamSeasons.getAll())
				.filter((ts: any) => ts.season === pendingSeason)
				.map((ts: any) => ({
					tid: ts.tid,
					playoffRoundsWon: ts.playoffRoundsWon,
					won: ts.won,
					cid: teamsNow.find((t: any) => t.tid === ts.tid)?.cid ?? ts.cid ?? 0,
				}));
			// Pre-draw lottery index L_i (post-playoff-update, before the draw's
			// decay) for the pool-manipulation analysis (leg c). Captured `cola`
			// is post-decay; `colaPre` is the index the lottery actually draws on.
			const colaPreByTid: Record<number, number> = {};
			for (const t of teamsNow as any[]) colaPreByTid[t.tid] = t.cola ?? 0;
			if (config.variant === "random") {
				// Channel probe / uniform-lottery baseline: assign a uniform random
				// permutation of round-1 picks across ALL teams, orthogonal to
				// record. Intent-to-treat: the assigned pick is drawn before any
				// trades, so it is orthogonal to team quality, and the
				// assigned-pick -> future-outcome slope is causal. Math.random is
				// seeded per replicate (runReplicate), so this is reproducible.
				const shuffled = tss.map((ts: any) => ts.tid);
				for (let i = shuffled.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
				}
				const order: Record<number, number> = {};
				shuffled.forEach((tid: number, i: number) => {
					order[tid] = i + 1;
				});
				await phase.newPhase(PHASE.DRAFT, NO_COND); // engine sets a lottery order...
				await injectDraftOrder(pendingSeason, order); // ...which we overwrite
				pendingTeams = await captureSeasonRecord(pendingSeason, colaPreByTid);
			} else if (config.variant === "weighted") {
				// Parameterized COLA lottery (the W dial as a one-knob family).
				// Draw the FULL draft order over the eligible pool (the 22 teams
				// that did not win a playoff round) weighted by cola^gamma, without
				// replacement; the 8 deep-playoff teams follow in reverse-record
				// order. gamma=0 is flat (uniform among eligible), gamma=1 is
				// proportional to the multi-year index (Classic-like), gamma>1
				// concentrates on the most-droughted. This removes the record-order
				// tail (picks 5+) Classic leaves, the residual tanking channel.
				const gamma = config.gamma ?? 1;
				// Eligibility (dial E): E=14 lotteries only the 14 non-playoff teams
				// (playoffRoundsWon < 0); E=22 (default) adds the 8 R1 losers
				// (playoffRoundsWon <= 0). The tail (picks after the pool) is the
				// complement, ordered by record.
				const e14 = config.E === 14;
				const inPool = (prw: number) => (e14 ? prw < 0 : prw <= 0);
				// lotteryDepth: Infinity (default) = full-depth lottery; a finite
				// value is the MIDDLE OPTION (top-`lotteryDepth` lottery, rest of the
				// pool ordered deterministically by index, not record).
				const lotteryDepth = config.lotteryDepth ?? Number.POSITIVE_INFINITY;
				const colaByTid: Record<number, number> = {};
				for (const t of teamsNow as any[]) colaByTid[t.tid] = t.cola ?? 0;
				const remaining = tss
					.filter((ts: any) => inPool(ts.playoffRoundsWon))
					.map((ts: any) => ({ tid: ts.tid, w: Math.pow(colaByTid[ts.tid] ?? 0, gamma) }));
				const order: Record<number, number> = {};
				let pickNum = 1;
				while (remaining.length > 0) {
					if (pickNum > lotteryDepth) {
						// Past the lottery depth: order the rest of the pool by index
						// (cola^gamma) DESC, deterministically -- by drought, not record.
						remaining.sort((a, b) => b.w - a.w);
						for (const r of remaining) order[r.tid] = pickNum++;
						break;
					}
					const total = remaining.reduce((s, x) => s + x.w, 0);
					let idx = 0;
					if (total > 0) {
						const roll = Math.random() * total;
						let cum = 0;
						for (let i = 0; i < remaining.length; i++) {
							cum += remaining[i]!.w;
							if (roll < cum) { idx = i; break; }
						}
					} else {
						// all-zero weights (gamma>0 with no accrued cola early on)
						idx = Math.floor(Math.random() * remaining.length);
					}
					order[remaining[idx]!.tid] = pickNum++;
					remaining.splice(idx, 1);
				}
				// Tail: teams outside the lottery pool pick after it, worst record
				// first (champion last). For E=22 that is the 8 deep-playoff teams;
				// for E=14, every playoff team (playoffRoundsWon >= 0).
				for (const ts of tss
					.filter((t: any) => !inPool(t.playoffRoundsWon))
					.slice()
					.sort((a: any, b: any) => a.won - b.won)) {
					order[ts.tid] = pickNum++;
				}
				await phase.newPhase(PHASE.DRAFT, NO_COND); // engine draws + decays ITS winners
				await injectDraftOrder(pendingSeason, order); // override the order
				// Evolve the index under THIS mechanism: restore the post-playoff
				// snapshot, then apply the after-lottery decay to MY top-4 winners
				// (mirrors the engine's DRAFT_LOTTERY_FACTORS), so the engine's
				// discarded draw does not corrupt next season's weights.
				const LOTTERY_DECAY = [0, 0.25, 0.5, 0.75];
				for (const t of await idb.cache.teams.getAll()) {
					let c = colaByTid[(t as any).tid] ?? 0;
					const pk = order[(t as any).tid];
					if (pk !== undefined && pk <= 4) c = Math.round(c * LOTTERY_DECAY[pk - 1]!);
					if (((t as any).cola ?? 0) !== c) {
						(t as any).cola = c;
						await idb.cache.teams.put(t);
					}
				}
				pendingTeams = await captureSeasonRecord(pendingSeason, colaPreByTid);
			} else if (config.variant === "nba" || config.variant === "t321") {
				// Record-based reference mechanisms (the own-metric comparison).
				// Both rank the pool by CURRENT-SEASON record; the multi-year index
				// plays no role in the draw. The index still evolves exactly as in
				// the weighted arms (engine accumulation + decay applied to THIS
				// mechanism's top-4 winners), so the drought covariate in the
				// seasonLog stays comparable across arms.
				//   "nba"  : the post-2019 NBA lottery. Pool = the 14 non-playoff
				//            teams; official pick-1 ball counts by record rank
				//            (140/140/140/125/105/90/75/60/45/30/20/15/10/5 per
				//            1000); top-4 drawn without replacement; picks 5-14 by
				//            record among the rest of the pool.
				//   "t321" : the 2026 3-2-1 proposal. Pool = 16 teams (per
				//            conference the bottom 8 by record, matching the
				//            16-tiered eligibility approximation); four record
				//            tiers of 4 get ball counts 2/3/2/1 (the bottom tier
				//            deliberately below tier 2); the top drawDepth picks
				//            drawn without replacement, remainder by record.
				const colaByTid: Record<number, number> = {};
				for (const t of teamsNow as any[]) colaByTid[t.tid] = t.cola ?? 0;
				let pool: any[];
				if (config.variant === "nba") {
					pool = tss.filter((ts: any) => ts.playoffRoundsWon < 0);
				} else {
					const byConf: Record<number, any[]> = {};
					for (const ts of tss) (byConf[ts.cid] ??= []).push(ts);
					pool = Object.values(byConf).flatMap((c: any[]) =>
						c.slice().sort((a, b) => a.won - b.won).slice(0, 8),
					);
				}
				pool.sort((a: any, b: any) => a.won - b.won); // worst record first
				const NBA_BALLS = [140, 140, 140, 125, 105, 90, 75, 60, 45, 30, 20, 15, 10, 5];
				const TIER_BALLS = [2, 3, 2, 1];
				const weightOf = (rank: number) =>
					config.variant === "nba"
						? NBA_BALLS[rank] ?? 5
						: TIER_BALLS[Math.min(3, Math.floor(rank / 4))]!;
				const drawDepth = config.variant === "nba" ? 4 : (config.drawDepth ?? 4);
				const remaining = pool.map((ts: any, i: number) => ({
					tid: ts.tid,
					w: weightOf(i),
					won: ts.won,
				}));
				const order: Record<number, number> = {};
				let pickNum = 1;
				while (remaining.length > 0) {
					if (pickNum > drawDepth) {
						// Past the draw depth: rest of the pool by record, worst first.
						remaining.sort((a, b) => a.won - b.won);
						for (const r of remaining) order[r.tid] = pickNum++;
						break;
					}
					const total = remaining.reduce((s, x) => s + x.w, 0);
					const roll = Math.random() * total;
					let cum = 0;
					let idx = 0;
					for (let i = 0; i < remaining.length; i++) {
						cum += remaining[i]!.w;
						if (roll < cum) {
							idx = i;
							break;
						}
					}
					order[remaining[idx]!.tid] = pickNum++;
					remaining.splice(idx, 1);
				}
				// Tail: teams outside the pool pick after it, worst record first.
				const poolTids = new Set(pool.map((ts: any) => ts.tid));
				for (const ts of tss
					.filter((t: any) => !poolTids.has(t.tid))
					.slice()
					.sort((a: any, b: any) => a.won - b.won)) {
					order[ts.tid] = pickNum++;
				}
				await phase.newPhase(PHASE.DRAFT, NO_COND); // engine draws + decays ITS winners
				await injectDraftOrder(pendingSeason, order); // override the order
				// Evolve the index under the SAME law as the weighted arms: restore
				// the post-playoff snapshot, decay MY top-4 winners.
				const LOTTERY_DECAY = [0, 0.25, 0.5, 0.75];
				for (const t of await idb.cache.teams.getAll()) {
					let c = colaByTid[(t as any).tid] ?? 0;
					const pk = order[(t as any).tid];
					if (pk !== undefined && pk <= 4) c = Math.round(c * LOTTERY_DECAY[pk - 1]!);
					if (((t as any).cola ?? 0) !== c) {
						(t as any).cola = c;
						await idb.cache.teams.put(t);
					}
				}
				pendingTeams = await captureSeasonRecord(pendingSeason, colaPreByTid);
			} else if (config.variant) {
				// Anchor: compute the order driver-side, inject over the engine's.
				const anchorTss: AnchorTeam[] = tss.map((ts: any) => ({
					tid: ts.tid,
					wins: ts.won,
					playoffRoundsWon: ts.playoffRoundsWon,
					cid: ts.cid,
				}));
				const order = computeAnchorOrder(config.variant, anchorTss, droughtState);
				await phase.newPhase(PHASE.DRAFT, NO_COND); // engine sets a lottery order...
				await injectDraftOrder(pendingSeason, order); // ...which we overwrite
				pendingTeams = await captureSeasonRecord(pendingSeason, colaPreByTid);
				// Phase B drought reset (post-draft): Countdown on top-3, Beckett on #1.
				for (const ts of anchorTss) {
					const pick = order[ts.tid];
					if (
						pick !== undefined &&
						((config.variant === "countdown" && pick <= 3) ||
							(config.variant === "beckett" && pick === 1))
					) {
						droughtState[ts.tid] = 0;
					}
				}
			} else {
				await applyEligibilityMask(config.E, tss); // Hook B.1
				await applyCapClamp(config.C); // Hook B.2
				await phase.newPhase(PHASE.DRAFT, NO_COND); // runs genOrder (real lottery draw)
				pendingTeams = await captureSeasonRecord(pendingSeason, colaPreByTid);
			}
			const champ = pendingTeams.find((t) => t.playoffRoundsWon === 4);
			priorChampionTid = champ ? champ.tid : null;
		} else if (ph === PHASE.DRAFT) {
			await draft.runPicks({ type: "untilEnd" }, NO_COND);
		} else if (ph === PHASE.AFTER_DRAFT) {
			await phase.newPhase(PHASE.RESIGN_PLAYERS, NO_COND);
		} else if (ph === PHASE.RESIGN_PLAYERS) {
			await phase.newPhase(PHASE.FREE_AGENCY, NO_COND);
		} else if (ph === PHASE.FREE_AGENCY) {
			await freeAgents.play(g.get("daysLeft"), NO_COND);
			// End of the season cycle: prune, time, and record.
			if (PRUNE) await pruneSeasonData();
			const cachePlayers = (await idb.cache.players.getAll()).length;
			records.push({
				season: pendingSeason,
				elapsedSecs: Number(((Date.now() - seasonStart) / 1000).toFixed(2)),
				cachePlayers,
				teams: pendingTeams ?? [],
			});
			seasonStart = Date.now();
		} else {
			throw new Error(`Unexpected phase in driver loop: ${ph}`);
		}
	}

	if (records.length < config.seasons) {
		throw new Error(
			`Driver stalled: ${records.length}/${config.seasons} seasons, last phase ${g.get("phase")}, guard ${guard}`,
		);
	}
	return records;
}

// --- Determinism + replicate wrapper ----------------------------------------

// Seed Math.random per replicate. ZenGM's randInt() (common/random.ts) routes
// through Math.random, so overriding it makes the WHOLE run reproducible for a
// fixed (config.id, seed): league generation, per-game sim, and the lottery
// draw all read the same stream. Restored after each replicate so it never
// leaks across replicates batched in one vitest process.
function hashSeed(configId: number, replicate: number, baseSeed: number) {
	let h = baseSeed >>> 0;
	h = ((h ^ configId) * 2654435761) >>> 0;
	h = ((h ^ replicate) * 2654435761) >>> 0;
	return h;
}
function mulberry32(seed: number) {
	return function () {
		let t = (seed += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Project rich driver records to the seasonLog shape objectives.js consumes.
function toSeasonLog(records: SeasonRec[]) {
	return records.map((r) => ({ season: r.season, teams: r.teams }));
}

async function runReplicate(config: Config, seed: number) {
	const original = Math.random;
	Math.random = mulberry32(hashSeed(config.id, seed, 42));
	try {
		return toSeasonLog(await runConfig(config));
	} finally {
		Math.random = original;
	}
}

// --- Env-driven sweep mode (drop-in for colaSweepDriver in sweep.js) ---------
// Reads the dial config + replicate seeds from env, writes
// [{ seed, seasonLog }, ...] to COLA_DRIVER_OUTPUT in the order requested.

test.skipIf(!process.env.COLA_DRIVER_CONFIG)(
	"full-engine COLA driver: env-driven sweep batch",
	{ timeout: 6 * 60 * 60 * 1000 },
	async () => {
		const config = JSON.parse(process.env.COLA_DRIVER_CONFIG!) as Config;
		const seeds = JSON.parse(
			process.env.COLA_DRIVER_REPLICATES ?? "[0]",
		) as number[];
		const outputPath = process.env.COLA_DRIVER_OUTPUT!;
		const results: { seed: number; seasonLog: any[] }[] = [];
		for (const seed of seeds) {
			const t0 = Date.now();
			const seasonLog = await runReplicate(config, seed);
			console.log(
				`[colaFullEngineDriver] cfg=${config.id} seed=${seed} seasons=${seasonLog.length} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`,
			);
			results.push({ seed, seasonLog });
		}
		fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
		expect(results.length).toBe(seeds.length);
	},
);

// --- Dev test ---------------------------------------------------------------

test.skipIf(!process.env.COLA_SPIKE)(
	"full-engine COLA driver scaffold: cfg 1 (Classic E=14) runs end-to-end",
	{ timeout: 20 * 60 * 1000 },
	async () => {
		const config: Config = {
			id: 1,
			E: 14,
			C: null,
			S: "unbounded",
			seasons: Number(process.env.COLA_DRIVER_SEASONS ?? 3),
		};

		const t0 = Date.now();
		const records = await runConfig(config);
		const wall = (Date.now() - t0) / 1000;

		const perSeason = records.map((r) => {
			const r1Losers = r.teams.filter((t) => t.playoffRoundsWon === 0);
			const r1LoserPicks = r1Losers
				.map((t) => t.draftPick)
				.filter((p): p is number => p !== null);
			const champ = r.teams.find((t) => t.playoffRoundsWon === 4);
			return {
				season: r.season,
				elapsedSecs: r.elapsedSecs,
				cachePlayers: r.cachePlayers,
				lotteryTeamsWithCola: r.teams.filter((t) => t.cola > 0).length,
				maxCola: Math.max(...r.teams.map((t) => t.cola)),
				r1LoserColaMax: r1Losers.length
					? Math.max(...r1Losers.map((t) => t.cola))
					: 0,
				r1LoserBestPick: r1LoserPicks.length ? Math.min(...r1LoserPicks) : null,
				championTid: champ?.tid ?? null,
				championCola: champ?.cola ?? null,
			};
		});

		const elapsed = perSeason.map((s) => s.elapsedSecs);
		const diag = {
			config,
			pruning: PRUNE,
			wallSecs: Number(wall.toFixed(2)),
			secPerSeason: Number((wall / records.length).toFixed(2)),
			firstSeasonSecs: elapsed[0],
			lastSeasonSecs: elapsed[elapsed.length - 1],
			driftRatio: Number((elapsed[elapsed.length - 1]! / elapsed[0]!).toFixed(2)),
			perSeason,
		};
		console.log("\n===== FULL-ENGINE DRIVER SCAFFOLD =====");
		console.log(JSON.stringify(diag, null, 2));
		console.log("=======================================\n");
		fs.writeFileSync(
			"/tmp/cola_fulldriver_diag.json",
			JSON.stringify(diag, null, 2),
		);

		// Mechanism assertions (the phase-stepping loop + dial hook):
		expect(records.length).toBe(config.seasons);
		for (const r of records) {
			// Every season produced a real lottery order (pick 1 was assigned).
			const picks = r.teams
				.map((t) => t.draftPick)
				.filter((p): p is number => p !== null);
			expect(picks).toContain(1);
		}
		for (const s of perSeason) {
			// Hook B (E=14): R1 losers zeroed before the draw...
			expect(s.r1LoserColaMax).toBe(0);
			// ...and the real engine honored it -- masked R1 losers fell OUT of
			// the 14-team lottery into rank order (pick > 14). Proof the dial
			// transform flowed into genOrder, not just the cache.
			if (s.r1LoserBestPick !== null) {
				expect(s.r1LoserBestPick).toBeGreaterThan(14);
			}
		}
		// Hook A / carryover: under S=unbounded, cola accumulates across droughts.
		expect(perSeason[perSeason.length - 1]!.maxCola).toBeGreaterThanOrEqual(
			2000,
		);
		// The cache working set plateaus rather than growing unbounded (the FA
		// pool reaches steady state; the residual sec/season drift is idb.league
		// query cost, addressed by the box-score/event prune + pilot tuning).
		if (records.length >= 3) {
			const firstCache = perSeason[0]!.cachePlayers;
			const lastCache = perSeason[perSeason.length - 1]!.cachePlayers;
			expect(lastCache).toBeLessThan(firstCache * 1.4); // bounded, not unbounded
		}
	},
);

afterAll(async () => {
	try {
		local.autoPlayUntil = undefined;
		if (g.get("lid") !== undefined) {
			await league.remove(g.get("lid"));
		}
	} catch {}
});
