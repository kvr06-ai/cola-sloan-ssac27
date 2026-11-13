// Engineering spike (Highley COLA collaboration, task #66).
//
// Question: can ZenGM's REAL league-creation pipeline (createStream) run
// headless in Node, producing the four features Highley flagged as missing
// from the synthesized testbed -- player rosters, AI GMs, contracts, and
// per-team city sizes?
//
// The Track B bypass (colaSweepDriver.test.ts) injected minimal team stubs
// (pop=1, no players) and ran only the lottery code. This spike tests the
// opposite: drive the actual createStream() the UI uses, exactly as
// src/test/smoke.test.browser.ts does, but in the NODE vitest project with a
// real fake-indexeddb backing connectMeta/connectLeague + the real Cache.
//
// Run:
//   npx vitest --run src/test/colaFullEngineSpike.test.ts --project basketball

import "fake-indexeddb/auto"; // global indexedDB for connectMeta/connectLeague + real Cache.flush
import * as fs from "node:fs";
import { afterAll, expect, test } from "vitest";
import { league } from "../worker/core/index.ts";
import { idb } from "../worker/db/index.ts";
import { g, helpers, local } from "../worker/util/index.ts";
import "../worker/index.ts";
import createStreamFromLeagueObject from "../worker/core/league/create/createStreamFromLeagueObject.ts";
import { LEAGUE_DATABASE_VERSION } from "../common/constants.ts";
import { getDefaultSettings } from "../worker/views/newLeague.ts";
import { last } from "../common/utils.ts";
import { defaultGameAttributes } from "../common/defaultGameAttributes.ts";

const buildProps = () => ({
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
	name: "ColaSpike",
	setLeagueCreationStatus: () => {},
	settings: getDefaultSettings(),
	shuffleRosters: false,
	startingSeasonFromInput: "2025",
	teamsFromInput: helpers.addPopRank(helpers.getTeamsDefault()),
	tid: 0,
});

// Env-gated like colaSweepDriver.test.ts so a bare `npm test` stays fast.
// Run with: COLA_SPIKE=1 npx vitest --run src/test/colaFullEngineSpike.test.ts --project basketball
test.skipIf(!process.env.COLA_SPIKE)(
	"createStream builds a full league headless in Node",
	{ timeout: 5 * 60 * 1000 },
	async () => {
		const stream = createStreamFromLeagueObject({});

		const t0 = Date.now();
		await league.createStream(stream, buildProps() as any);
		const createSecs = (Date.now() - t0) / 1000;

		const players = await idb.cache.players.getAll();
		const teams = await idb.cache.teams.getAll();
		const teamSeasons = await idb.cache.teamSeasons.getAll();

		// ---- Feature 1: player rosters -----------------------------------
		const onRoster = players.filter((p: any) => p.tid >= 0);
		const byTid: Record<number, number> = {};
		for (const p of onRoster) byTid[p.tid] = (byTid[p.tid] ?? 0) + 1;
		const rosterSizes = Object.values(byTid);
		const minRoster = Math.min(...rosterSizes);
		const maxRoster = Math.max(...rosterSizes);

		// ---- Feature 2: contracts ----------------------------------------
		const withContract = onRoster.filter(
			(p: any) => p.contract && p.contract.amount > 0 && p.contract.exp,
		);
		const sampleContracts = onRoster
			.slice(0, 5)
			.map((p: any) => p.contract);

		// ---- Feature 3: AI GMs -------------------------------------------
		// In ZenGM all non-user teams are AI-controlled. The initialized
		// surface: userTids = [0], every team carries a strategy
		// (rebuilding/contending), and depth charts exist for sim.
		const userTids = g.get("userTids");
		const strategies = teams.map((t: any) => t.strategy);
		const withStrategy = strategies.filter(
			(s: any) => s === "rebuilding" || s === "contending",
		);

		// ---- Feature 4: city sizes ---------------------------------------
		const pops = teams.map((t: any) => t.pop);
		const distinctPops = new Set(pops.map((p: number) => Math.round(p * 100) / 100));
		const popRanks = teams.map((t: any) => t.popRank).filter((x: any) => x != null);

		console.log("\n===== COLA FULL-ENGINE SPIKE: createStream headless =====");
		console.log(`createStream wall time:        ${createSecs.toFixed(2)} s`);
		console.log(`g.season / startingSeason:     ${g.get("season")} / ${g.get("startingSeason")}`);
		console.log(`g.phase:                       ${g.get("phase")}`);
		console.log(`g.numActiveTeams:              ${g.get("numActiveTeams")}`);
		console.log(`g.draftType:                   ${g.get("draftType")}`);
		console.log(`g.userTids:                    ${JSON.stringify(userTids)}`);
		console.log("--- Feature 1: rosters ---");
		console.log(`total players:                 ${players.length}`);
		console.log(`players on a roster (tid>=0):  ${onRoster.length}`);
		console.log(`teams with a roster:           ${rosterSizes.length}`);
		console.log(`roster size min/max:           ${minRoster} / ${maxRoster}`);
		console.log("--- Feature 2: contracts ---");
		console.log(`rostered w/ valid contract:    ${withContract.length} / ${onRoster.length}`);
		console.log(`sample contracts:              ${JSON.stringify(sampleContracts)}`);
		console.log("--- Feature 3: AI GMs ---");
		console.log(`teams w/ strategy set:         ${withStrategy.length} / ${teams.length}`);
		console.log(`distinct strategies:           ${JSON.stringify([...new Set(strategies)])}`);
		console.log("--- Feature 4: city sizes ---");
		console.log(`distinct team pops:            ${distinctPops.size}`);
		console.log(`pop range:                     ${Math.min(...pops)} .. ${Math.max(...pops)}`);
		console.log(`popRank present:               ${popRanks.length} / ${teams.length}`);
		console.log(`teamSeasons rows:              ${teamSeasons.length}`);
		console.log("=========================================================\n");

		fs.writeFileSync(
			"/tmp/cola_spike_diag.json",
			JSON.stringify(
				{
					createSecs,
					season: g.get("season"),
					startingSeason: g.get("startingSeason"),
					phase: g.get("phase"),
					numActiveTeams: g.get("numActiveTeams"),
					draftType: g.get("draftType"),
					userTids,
					totalPlayers: players.length,
					onRoster: onRoster.length,
					teamsWithRoster: rosterSizes.length,
					minRoster,
					maxRoster,
					rosteredWithContract: withContract.length,
					sampleContracts,
					teamsWithStrategy: withStrategy.length,
					distinctStrategies: [...new Set(strategies)],
					distinctPops: distinctPops.size,
					popMin: Math.min(...pops),
					popMax: Math.max(...pops),
					popRankPresent: popRanks.length,
					teamSeasonsRows: teamSeasons.length,
					samplePlayer: onRoster[0]
						? {
								tid: onRoster[0].tid,
								name: `${onRoster[0].firstName} ${onRoster[0].lastName}`,
								age: onRoster[0].born ? g.get("season") - onRoster[0].born.year : null,
								ovr: onRoster[0].ratings?.[onRoster[0].ratings.length - 1]?.ovr,
								pot: onRoster[0].ratings?.[onRoster[0].ratings.length - 1]?.pot,
								contract: onRoster[0].contract,
								numRatings: onRoster[0].ratings?.length,
							}
						: null,
					sampleTeams: teams.slice(0, 6).map((t: any) => ({
						region: t.region,
						name: t.name,
						pop: t.pop,
						popRank: t.popRank,
						strategy: t.strategy,
						cid: t.cid,
						did: t.did,
					})),
				},
				null,
				2,
			),
		);

		// Assertions (loose; the diagnostics above are the real signal).
		expect(teams.length).toBe(30);
		expect(players.length).toBeGreaterThan(300);
		expect(onRoster.length).toBeGreaterThan(30 * 10);
		expect(minRoster).toBeGreaterThanOrEqual(10);
		expect(withContract.length).toBe(onRoster.length);
		expect(withStrategy.length).toBe(30);
		expect(distinctPops.size).toBeGreaterThan(10);
		expect(userTids).toEqual([0]);
	},
);

afterAll(async () => {
	try {
		if (g.get("lid") !== undefined) {
			await league.remove(g.get("lid"));
		}
	} catch {}
	try {
		local.leagueLoaded = false;
	} catch {}
});
