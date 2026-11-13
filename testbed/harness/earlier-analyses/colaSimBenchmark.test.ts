// Engineering spike, part 2 (Highley COLA collaboration, task #67 pilot).
//
// Question: can ZenGM's per-game season engine (regular season + playoffs +
// draft + free agency, all AI-GM-driven) run headless in Node, and what is
// the actual sec/season on this M3 Max? Highley's compute estimate assumed
// 20 sec/season; this measures the real number to size the hybrid sweep.
//
// Drives the league with the engine's own autoPlayUntil self-continuation
// (the mechanism phase/finalize.ts uses), exactly as smoke.test.browser.ts
// does, but in the NODE vitest project.
//
// Run:
//   npx vitest --run src/test/colaSimBenchmark.test.ts --project basketball

import "fake-indexeddb/auto";
import * as fs from "node:fs";
import { afterAll, expect, test } from "vitest";
import { league } from "../worker/core/index.ts";
import { idb } from "../worker/db/index.ts";
import { g, helpers, local } from "../worker/util/index.ts";
import "../worker/index.ts";
import createStreamFromLeagueObject from "../worker/core/league/create/createStreamFromLeagueObject.ts";
import { LEAGUE_DATABASE_VERSION, PHASE } from "../common/constants.ts";
import { getDefaultSettings } from "../worker/views/newLeague.ts";
import { last } from "../common/utils.ts";
import { defaultGameAttributes } from "../common/defaultGameAttributes.ts";

const N_SEASONS = Number(process.env.COLA_BENCH_SEASONS ?? 3);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Env-gated like colaSweepDriver.test.ts so a bare `npm test` stays fast.
// Run with: COLA_SPIKE=1 COLA_BENCH_SEASONS=5 npx vitest --run src/test/colaSimBenchmark.test.ts --project basketball
test.skipIf(!process.env.COLA_SPIKE)(
	`headless per-game simulation benchmark (${N_SEASONS} seasons)`,
	{ timeout: 20 * 60 * 1000 },
	async () => {
		const START_SEASON = 2025;

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
			name: "ColaBench",
			setLeagueCreationStatus: () => {},
			settings: getDefaultSettings(),
			shuffleRosters: false,
			startingSeasonFromInput: String(START_SEASON),
			teamsFromInput: helpers.addPopRank(helpers.getTeamsDefault()),
			tid: 0,
		} as any);

		const targetSeason = START_SEASON + N_SEASONS;

		// Self-driving sim via the engine's own autoPlayUntil mechanism.
		local.autoPlayUntil = {
			season: targetSeason,
			phase: PHASE.PRESEASON,
			start: Date.now(),
		};

		const perSeason: { season: number; secs: number }[] = [];
		let lastSeason = g.get("season");
		let lastTick = Date.now();
		const t0 = Date.now();

		void league.autoPlay();

		// Poll until we reach the target season. Record per-season wall time as
		// g.season ticks over.
		const deadline = Date.now() + 19 * 60 * 1000;
		while (g.get("season") < targetSeason) {
			await sleep(250);
			const s = g.get("season");
			if (s > lastSeason) {
				const now = Date.now();
				perSeason.push({ season: lastSeason, secs: (now - lastTick) / 1000 });
				lastSeason = s;
				lastTick = now;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`Timed out at season ${g.get("season")} phase ${g.get("phase")} (target ${targetSeason})`,
				);
			}
		}

		const totalSecs = (Date.now() - t0) / 1000;
		// Let any detached DB activity settle (free-agency promise break).
		await sleep(3000);

		const players = await idb.cache.players.getAll();
		const teamSeasons = await idb.cache.teamSeasons.getAll();
		const games = await idb.cache.games.getAll();

		// Games-played evidence: a fully simulated NBA regular season is 82 gp.
		// teamSeason has no top-level gp field; games played = won+lost(+tied+otl).
		const gpValues = teamSeasons.map(
			(ts: any) => (ts.won ?? 0) + (ts.lost ?? 0) + (ts.tied ?? 0) + (ts.otl ?? 0),
		);
		const maxGp = gpValues.length ? Math.max(...gpValues) : 0;

		const secPerSeason = totalSecs / N_SEASONS;

		const diag = {
			nSeasons: N_SEASONS,
			startSeason: START_SEASON,
			endSeason: g.get("season"),
			endPhase: g.get("phase"),
			totalSecs: Number(totalSecs.toFixed(2)),
			secPerSeason: Number(secPerSeason.toFixed(2)),
			perSeason: perSeason.map((p) => ({
				season: p.season,
				secs: Number(p.secs.toFixed(2)),
			})),
			// Evidence the full engine actually ran:
			totalPlayersNow: players.length,
			teamSeasonsRows: teamSeasons.length,
			maxGamesPlayedInASeason: maxGp,
			cachedGamesRows: games.length,
			// Hybrid-sweep projections at this measured rate:
			projHybrid_13500seasons_hrs_1core: Number(
				((13500 * secPerSeason) / 3600).toFixed(1),
			),
			projHybrid_13500seasons_hrs_12core: Number(
				((13500 * secPerSeason) / 3600 / 12).toFixed(1),
			),
			projFull_72000seasons_hrs_12core: Number(
				((72000 * secPerSeason) / 3600 / 12).toFixed(1),
			),
		};

		console.log("\n===== COLA SIM BENCHMARK =====");
		console.log(JSON.stringify(diag, null, 2));
		console.log("==============================\n");
		fs.writeFileSync("/tmp/cola_bench_diag.json", JSON.stringify(diag, null, 2));

		// The engine genuinely advanced multiple seasons with real games on disk.
		expect(g.get("season")).toBe(targetSeason);
		// Player pool grew via real draft classes -> proves the full pipeline ran.
		expect(players.length).toBeGreaterThan(750);
		// A completed regular season has 82 games (won+lost) for at least one team.
		expect(maxGp).toBeGreaterThanOrEqual(82);
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
