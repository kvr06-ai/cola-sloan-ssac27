#!/usr/bin/env node
/**
 * Basketball-GM COLA sweep driver.
 *
 * Reads `dial_grid.json`, expands the 7-dial grid into 48 configurations,
 * invokes the zengm engine headlessly for each (config, replicate), parses
 * the per-season output, evaluates the four objectives (objectives.js), and
 * aggregates one CSV row per (config_id, replicate_id).
 *
 * STATUS (Track B real-engine driver, 2026-05-26):
 *   - Grid expansion: implemented.
 *   - zengm invocation: REAL. Drives `zengm-fork/src/worker/core/draft/
 *     colaSweepDriver.test.ts` via vitest. The driver bootstraps a 30-team
 *     league directly into the mocked IDB cache, synthesizes season outcomes
 *     (wins + playoff bracket), then invokes real ZenGM `cola.updateLottery
 *     ChancesAfterPlayoffs`, `draft.genOrder`, and `cola.updateLotteryChances
 *     AfterLottery` for each simulated season. The `--stub` flag keeps the
 *     synthetic-season path available for fast pipeline checks.
 *   - Objective evaluation: implemented (objectives.js).
 *   - CSV output: implemented.
 *
 * USAGE:
 *   node sweep.js --smoke                    # one config, one replicate, real engine
 *   node sweep.js --smoke --stub             # one config, one replicate, stub engine
 *   node sweep.js --config-id 0 --replicates 50
 *   node sweep.js --full                     # all 48 configs * 50 replicates
 */

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { evaluateAll } = require('./objectives.js');

const ZENGM_FORK_DIR = path.join(__dirname, 'zengm-fork');
// Driver selection. Default: the synthesized Track B testbed (fast 48-config
// screen). COLA_FULL_ENGINE=1: the full ZenGM engine driver (per-game sim, real
// rosters/contracts/AI GMs), used to re-derive the frontier (validation design
// v2). Both honor the same env contract (COLA_DRIVER_CONFIG / _REPLICATES /
// _OUTPUT -> [{seed, seasonLog}]), so the objectives + CSV pipeline is unchanged.
const DRIVER_TEST_REL = process.env.COLA_FULL_ENGINE
	? 'src/test/colaFullEngineDriver.test.ts'
	: 'src/worker/core/draft/colaSweepDriver.test.ts';

// =============================================================================
// 1. Grid expansion: dial_grid.json -> 48 explicit configurations.
// =============================================================================

function loadGrid(gridPath) {
    const raw = JSON.parse(fs.readFileSync(gridPath, 'utf8'));
    const meta = raw._meta || {};
    const { dials, fixed_at_classic_cola_defaults } = raw;
    const seasonsPerConfig = meta.seasons_per_config;
    const sensitivityChecks = meta.sensitivity_checks || [];
    const expectedTotal = meta.total_configurations;

    const configs = [];
    let id = 0;
    for (const E of dials.E) {
        for (const C of dials.C) {
            for (const S of dials.S) {
                configs.push({
                    id: id++,
                    E,
                    C,
                    S,
                    delta: fixed_at_classic_cola_defaults.delta,
                    rho: fixed_at_classic_cola_defaults.rho,
                    W: fixed_at_classic_cola_defaults.W,
                    T: fixed_at_classic_cola_defaults.T,
                    seasons: seasonsPerConfig,
                });
            }
        }
    }
    if (expectedTotal !== undefined && configs.length !== expectedTotal) {
        throw new Error(`Grid expansion: expected ${expectedTotal} configs, got ${configs.length}`);
    }

    // Off-grid named anchors (Countdown, Beckett). These are non-cola
    // mechanisms (different W / increment / eligibility) implemented as bespoke
    // driver configs, not grid points. They are only runnable under the full
    // engine (the synthesized Track B driver has no `variant` handling), so they
    // are appended only when COLA_FULL_ENGINE is set. E/C are nominal (the
    // anchors ignore the cola dials); they exist so objectives.js still produces
    // a manipulation-gain value -- which is NOT well-defined for a non-cola
    // mechanism and is flagged as such (see ASSUMPTIONS.md).
    if (process.env.COLA_FULL_ENGINE && raw._named_anchors && raw._named_anchors.anchors) {
        const fixed = fixed_at_classic_cola_defaults;
        const variantByKey = { 'countdown-cola': 'countdown', 'beckett-cola': 'beckett' };
        for (const [key, variant] of Object.entries(variantByKey)) {
            if (raw._named_anchors.anchors[key]) {
                configs.push({
                    id: id++, E: 22, C: null, S: 'unbounded',
                    delta: fixed.delta, rho: fixed.rho, W: fixed.W, T: fixed.T,
                    seasons: seasonsPerConfig, variant,
                });
            }
        }
    }

    return { configs, meta, sensitivity_checks: sensitivityChecks };
}

// =============================================================================
// 2. zengm invocation: REAL engine driver via vitest subprocess.
//
// We invoke `colaSweepDriver.test.ts` inside the zengm-fork via the project's
// own vitest CLI. That harness uses zengm's `src/test/setup.ts` to populate
// `self.bbgm` in Node (the same setup `genOrderNBA.test.ts` relies on). The
// driver reads its config from COLA_DRIVER_CONFIG and writes a season log to
// COLA_DRIVER_OUTPUT.
//
// Engine pieces used (REAL):
//   - cola.updateLotteryChancesAfterPlayoffs  (zengm-fork/src/worker/core/draft/cola.ts)
//   - cola.updateLotteryChancesAfterLottery   (zengm-fork/src/worker/core/draft/cola.ts)
//   - draft.genOrder(mock=true)               (zengm-fork/src/worker/core/draft/genOrder.ts)
//
// Synthesized in the driver (NOT real ZenGM game simulation):
//   - Per-season wins (strength-weighted random + noise)
//   - Single-elimination bracket outcomes (probability proportional to strength)
//   - Player generation, salary cap, trades, free agency: all bypassed
//
// Dials applied via local patches in the driver (no source modification):
//   - E (eligibility): cola=0 mask on ineligible teams before genOrder
//   - C (cap):         Math.min(cola, C) clamp after updateLotteryChancesAfterPlayoffs
//   - S (carry-over):  pre-update zero / window-replay / champion-reset
//   - Δ, ρ, W, T:      Classic defaults, baked into ZenGM cola.ts (PLAYOFF_FACTORS,
//                      DRAFT_LOTTERY_FACTORS, COLA_ALPHA, lottery chance computation).
// =============================================================================

function runZengmSeasonReal(config, replicateSeed) {
    // Backward-compatible wrapper around the batched path. The original
    // single-replicate entry point is retained so existing callers and the
    // module's public API (see module.exports below) keep working.
    const [{ seasonLog }] = runZengmSeasonsRealBatch(config, [replicateSeed]);
    return seasonLog;
}

/**
 * Run N replicates of one config inside a SINGLE vitest subprocess. This
 * amortises the ~3 s vitest startup over N replicates. The driver loops over
 * seeds internally and writes a JSON array `[{ seed, seasonLog }, ...]` to
 * COLA_DRIVER_OUTPUT.
 *
 * @param {Object} config - dial configuration
 * @param {number[]} seeds - per-replicate seeds (length N)
 * @returns {Array<{ seed: number, seasonLog: Array }>} per-replicate results
 *          in the order requested.
 */
function runZengmSeasonsRealBatch(config, seeds) {
    if (!Array.isArray(seeds) || seeds.length === 0) {
        throw new Error("runZengmSeasonsRealBatch: seeds must be a non-empty array");
    }

    const driverConfig = {
        id: config.id,
        E: config.E,
        C: config.C,
        S: config.S,
        delta: config.delta,
        rho: config.rho,
        W: config.W,
        T: config.T,
        variant: config.variant, // off-grid named anchors (countdown/beckett); undefined for grid
        seasons: config.seasons,
        // `seed` is the LEGACY single-replicate field — when COLA_DRIVER_REPLICATES
        // is set (batched mode), the driver ignores this and iterates over the
        // batch seeds instead. Set to the first seed as a sensible default.
        seed: seeds[0],
    };
    const outputPath = path.join(
        __dirname,
        'runs',
        `_driver_out_${process.pid}_cfg${config.id}_batch${seeds.length}_${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const env = Object.assign({}, process.env, {
        COLA_DRIVER_CONFIG: JSON.stringify(driverConfig),
        COLA_DRIVER_OUTPUT: outputPath,
        COLA_DRIVER_REPLICATES: JSON.stringify(seeds),
    });

    const result = child_process.spawnSync(
        path.join(ZENGM_FORK_DIR, 'node_modules/.bin/vitest'),
        ['--run', '--project', 'basketball', DRIVER_TEST_REL],
        { cwd: ZENGM_FORK_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    if (result.status !== 0) {
        console.error('vitest stdout:\n' + result.stdout);
        console.error('vitest stderr:\n' + result.stderr);
        throw new Error(`zengm driver exited with status ${result.status}`);
    }
    if (!fs.existsSync(outputPath)) {
        console.error('vitest stdout:\n' + result.stdout);
        throw new Error(`zengm driver produced no output at ${outputPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    fs.unlinkSync(outputPath);

    // The batched driver writes [{ seed, seasonLog }, ...] in the order it
    // received them. Verify shape so older driver versions (pre-batching) fail
    // loudly rather than silently dropping replicates.
    if (!Array.isArray(raw) || raw.length !== seeds.length || !raw.every((r) => Array.isArray(r.seasonLog))) {
        throw new Error(
            `runZengmSeasonsRealBatch: driver output shape mismatch (expected array of {seed, seasonLog} length ${seeds.length}, got ${JSON.stringify(raw).slice(0, 200)})`,
        );
    }
    return raw;
}

function runZengmSeasonStub(config, replicate, seed) {
    // TODO: replace with real zengm invocation. See above for three approaches.
    // The stub fabricates one season's worth of team-result records, sufficient
    // for objectives.js to compute non-NaN outputs in the scaffold smoke test.

    const NUM_TEAMS = 30;
    const NUM_PLAYOFF_TEAMS = 16;  // NBA-style: 8 per conference
    const teams = [];

    // PRNG seeded by (config_id, replicate, seed) for reproducibility.
    const rng = mulberry32(hashSeed(config.id, replicate, seed));

    // Generate win totals with mild parity. Wins range 20..62.
    const winList = Array.from({ length: NUM_TEAMS }, () => 20 + Math.floor(rng() * 42));
    winList.sort((a, b) => b - a);

    // Assign top-8 from each conference (use shuffled indices) to the playoffs.
    const indices = Array.from({ length: NUM_TEAMS }, (_, i) => i);
    shuffle(indices, rng);
    const eastTids = indices.slice(0, NUM_TEAMS / 2);
    const westTids = indices.slice(NUM_TEAMS / 2);

    // For each conference, rank by win total and seed.
    const buildConf = (confTids, confLabel) => {
        const ranked = confTids
            .map(tid => ({ tid, wins: winList[tid], conf: confLabel }))
            .sort((a, b) => b.wins - a.wins);
        const playoffEntrants = ranked.slice(0, 8);
        const lotteryTeams = ranked.slice(8);
        return { ranked, playoffEntrants, lotteryTeams };
    };
    const east = buildConf(eastTids, 'E');
    const west = buildConf(westTids, 'W');

    // Round outcomes (uniform random with stub bracketing).
    const allLottery = [...east.lotteryTeams, ...west.lotteryTeams];
    const draftPickOrder = allLottery
        .slice()
        .sort((a, b) => a.wins - b.wins)
        .map((t, idx) => ({ ...t, draftPick: idx + 1 }));
    const tidToPick = Object.fromEntries(draftPickOrder.map(t => [t.tid, t.draftPick]));

    // Simulate playoff outcomes round by round (uniform random survivors).
    const simulateConfPlayoffs = (entrants) => {
        let alive = entrants.map(t => ({ ...t, playoffRoundsWon: 0 }));
        for (let round = 0; round < 3; round++) {  // R1 -> R2 -> CF
            const next = [];
            for (let i = 0; i < alive.length; i += 2) {
                const winner = rng() < 0.5 ? alive[i] : alive[i + 1];
                const loser = winner === alive[i] ? alive[i + 1] : alive[i];
                winner.playoffRoundsWon = round + 1;
                next.push(winner);
                // loser stays at playoffRoundsWon = round
            }
            alive = next;
        }
        return alive[0];  // conference champion (made finals)
    };
    const eastChamp = simulateConfPlayoffs(east.playoffEntrants);
    const westChamp = simulateConfPlayoffs(west.playoffEntrants);
    // Finals
    const champ = rng() < 0.5 ? eastChamp : westChamp;
    const runnerUp = champ === eastChamp ? westChamp : eastChamp;
    champ.playoffRoundsWon = 4;
    runnerUp.playoffRoundsWon = 3;

    // Assemble team-record list.
    for (const confData of [east, west]) {
        // Lottery teams: playoffRoundsWon = -1
        for (const t of confData.lotteryTeams) {
            teams.push({
                tid: t.tid,
                conf: t.conf,
                wins: t.wins,
                playoffRoundsWon: -1,
                draftPick: tidToPick[t.tid] ?? null,
                cola: Math.round(rng() * 5000),  // placeholder index value
            });
        }
        // Playoff teams: walk the bracket
        for (const t of confData.playoffEntrants) {
            let pr = 0;
            if (t === champ) pr = 4;
            else if (t === runnerUp) pr = 3;
            else {
                // Walked the bracket: deduce roundsWon from whether they appeared in CF/R2/R1.
                // For scaffold simplicity, sample uniformly.
                pr = Math.floor(rng() * 3);
            }
            teams.push({
                tid: t.tid,
                conf: t.conf,
                wins: t.wins,
                playoffRoundsWon: pr,
                draftPick: null,
                cola: 0,
            });
        }
    }

    return {
        season: replicate,
        teams,
    };
}

// =============================================================================
// 3. Utility: deterministic PRNG (mulberry32) and seed hash.
// =============================================================================

function hashSeed(configId, replicate, baseSeed) {
    // Combine three integers into a 32-bit seed deterministically.
    let h = baseSeed >>> 0;
    h = ((h ^ configId) * 2654435761) >>> 0;
    h = ((h ^ replicate) * 2654435761) >>> 0;
    return h;
}

function mulberry32(seed) {
    return function () {
        let t = (seed += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// =============================================================================
// 4. Main driver: iterate configs, run replicates, aggregate, write CSV.
// =============================================================================

function runSweep({ gridPath, outPath, configIdsToRun, replicates, mode, useStub, seasonsOverride, seeds: seedsOverride }) {
    const { configs } = loadGrid(gridPath);

    let targetConfigs = (configIdsToRun === 'all')
        ? configs
        : configs.filter(c => configIdsToRun.includes(c.id));
    if (seasonsOverride !== undefined) {
        targetConfigs = targetConfigs.map(c => ({ ...c, seasons: seasonsOverride }));
    }

    const csvHeader = [
        'config_id', 'replicate_id', 'E', 'C', 'S', 'delta', 'seasons',
        'max_years_between_conf_finals',
        'franchises_never_reached_cf',
        // 2026-06-16 rebuild: the analytic manipulation columns are dropped (see
        // objectives.js evaluateAll). Manipulation is measured by a simulated
        // manipulator in a separate driver, not scored here.
        'rank_one_to_five_spread',
        'expected_pick_worst',
        'expected_pick_fifth_worst',
        // 'grid' for the 48 dial configs; 'countdown'/'beckett' for the off-grid
        // named anchors (appended last so the schema stays backward-compatible).
        'variant',
    ];

    const rows = [csvHeader.join(',')];
    let runIdx = 0;

    console.log(`Sweep mode=${mode} useStub=${useStub} configs=${targetConfigs.length} replicates/config=${replicates}`);

    // Build the per-config seed list once. If the caller supplied an explicit
    // `seeds` array (e.g. for the verification run with [42, 43, 44, 45, 46]),
    // use it; otherwise default to 0..N-1 to preserve the legacy behavior.
    const buildSeeds = () => {
        if (Array.isArray(seedsOverride) && seedsOverride.length > 0) {
            return seedsOverride.slice(0, replicates);
        }
        return Array.from({ length: replicates }, (_, i) => i);
    };

    const writeRow = (config, replicateId, result) => {
        rows.push([
            config.id,
            replicateId,
            config.E,
            config.C === null ? 'null' : config.C,
            config.S,
            config.delta,
            config.seasons,
            result.max_years_between_conf_finals,
            result.franchises_never_reached_cf,
            result.rank_one_to_five_spread,
            result.expected_pick_worst,
            result.expected_pick_fifth_worst,
            config.variant || 'grid',
        ].join(','));
    };

    for (const config of targetConfigs) {
        if (useStub) {
            // Stub path: each "season" is one synthesized year — keep the legacy
            // per-replicate loop because the stub does not amortise startup.
            for (let rep = 0; rep < replicates; rep++) {
                const seasonLog = [];
                for (let s = 0; s < config.seasons; s++) {
                    seasonLog.push(runZengmSeasonStub(config, rep * config.seasons + s, 42));
                }
                const result = evaluateAll(config, seasonLog);
                writeRow(config, rep, result);
                runIdx++;
                if (mode === 'smoke') {
                    console.log(`[smoke] config_id=${config.id} replicate=${rep}: ${JSON.stringify(result, null, 2)}`);
                    break;
                }
            }
        } else {
            // Real path: batch all replicates of this config into ONE vitest
            // subprocess invocation. The ~3 s startup is paid once per config
            // instead of once per (config, replicate).
            const seeds = buildSeeds();
            const seedsToRun = mode === 'smoke' ? seeds.slice(0, 1) : seeds;
            const t0 = Date.now();
            const batch = runZengmSeasonsRealBatch(config, seedsToRun);
            const elapsed = (Date.now() - t0) / 1000;
            const perReplicate = elapsed / seedsToRun.length;
            console.log(`  [real] config=${config.id} seeds=${JSON.stringify(seedsToRun)} seasons=${config.seasons} elapsed=${elapsed.toFixed(1)}s (${perReplicate.toFixed(2)}s/replicate amortised)`);

            for (let i = 0; i < batch.length; i++) {
                const { seed, seasonLog } = batch[i];
                const result = evaluateAll(config, seasonLog);
                // For headline runs, replicate_id reflects the seed actually used.
                // This is more useful than a sequential 0..N-1 index because reruns
                // with the same seed produce bit-identical rows (RNG determinism).
                writeRow(config, seed, result);
                runIdx++;
                if (mode === 'smoke') {
                    console.log(`[smoke] config_id=${config.id} seed=${seed}: ${JSON.stringify(result, null, 2)}`);
                    break;
                }
            }
        }
        if (mode === 'smoke') break;
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, rows.join('\n') + '\n');
    console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);
}

// =============================================================================
// 4b. Parallel + resumable sweep runner.
//
// runSweep() above accumulates every row in memory and writes the CSV once at
// the end -- fine for the ~minutes-long synthesized sweep, but fatal for a ~24h
// full-engine sweep (a crash/sleep loses everything). This runner splits the
// work into independent (config, seed-chunk) UNITS, each of which:
//   - runs in its own driver subprocess, so a pool of `concurrency` units runs
//     in parallel (~12-way on a 16-core M3 Max turns ~12 days into ~24h), and
//   - writes its rows to its own file on completion (atomic tmp + rename), so a
//     re-run with the SAME --name skips finished units and resumes.
// Bounded loss on interruption = the in-flight units only (~chunk-size x 7min).
// =============================================================================

// Columns must stay in sync with runSweep's csvHeader above (kept local so the
// sequential path is untouched; both end with the `variant` column).
const PAR_CSV_HEADER = [
    'config_id', 'replicate_id', 'E', 'C', 'S', 'delta', 'seasons',
    'max_years_between_conf_finals', 'franchises_never_reached_cf',
    'rank_one_to_five_spread', 'expected_pick_worst', 'expected_pick_fifth_worst',
    'variant',
];

function parBuildRow(config, seed, r) {
    return [
        config.id, seed, config.E, config.C === null ? 'null' : config.C, config.S,
        config.delta, config.seasons,
        r.max_years_between_conf_finals, r.franchises_never_reached_cf,
        r.rank_one_to_five_spread, r.expected_pick_worst, r.expected_pick_fifth_worst,
        config.variant || 'grid',
    ].join(',');
}

// Non-blocking driver invocation (one subprocess for a chunk of seeds). Same env
// contract as runZengmSeasonsRealBatch, but returns a Promise.
function runDriverAsync(config, seeds) {
    return new Promise((resolve, reject) => {
        const driverConfig = {
            id: config.id, E: config.E, C: config.C, S: config.S,
            delta: config.delta, rho: config.rho, W: config.W, T: config.T,
            variant: config.variant, seasons: config.seasons, seed: seeds[0],
        };
        const outputPath = path.join(__dirname, 'runs',
            `_driver_${process.pid}_cfg${config.id}_${seeds[0]}-${seeds[seeds.length - 1]}_${Date.now()}_${Math.round(performance.now())}.json`);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const env = Object.assign({}, process.env, {
            COLA_DRIVER_CONFIG: JSON.stringify(driverConfig),
            COLA_DRIVER_OUTPUT: outputPath,
            COLA_DRIVER_REPLICATES: JSON.stringify(seeds),
        });
        const child = child_process.spawn(
            path.join(ZENGM_FORK_DIR, 'node_modules/.bin/vitest'),
            ['--run', '--project', 'basketball', DRIVER_TEST_REL],
            { cwd: ZENGM_FORK_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            // The full-engine driver writes its output synchronously before the
            // test resolves, but vitest can still exit non-zero afterward:
            // freeing the large (~4GB) 30-season league heap routinely exceeds
            // the worker-teardown timeout, so the pool force-kills the fork.
            // That exit code is cosmetic -- the unit's data is already on disk.
            // Gate success on output validity (shape + full season count), not
            // the exit code; a missing/short output is the true failure signal.
            if (!fs.existsSync(outputPath)) {
                reject(new Error(`driver exit ${code}, no output: ${stderr.slice(-400)}`)); return;
            }
            try {
                const raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                fs.unlinkSync(outputPath);
                const wantSeasons = config.seasons;
                const ok = Array.isArray(raw) && raw.length === seeds.length
                    && raw.every((x) => Array.isArray(x.seasonLog)
                        && (wantSeasons ? x.seasonLog.length === wantSeasons : x.seasonLog.length > 0));
                if (!ok) {
                    reject(new Error(`driver output shape mismatch (expected ${seeds.length} seeds x ${wantSeasons ?? '>0'} seasons; exit ${code})`)); return;
                }
                resolve(raw);
            } catch (e) { reject(e); }
        });
    });
}

async function runSweepParallel({ gridPath, sweepDir, configIdsToRun, replicates, seasonsOverride, seeds: seedsOverride, concurrency, chunkSize }) {
    const { configs } = loadGrid(gridPath);
    let targetConfigs = (configIdsToRun === 'all') ? configs : configs.filter((c) => configIdsToRun.includes(c.id));
    if (seasonsOverride !== undefined) targetConfigs = targetConfigs.map((c) => ({ ...c, seasons: seasonsOverride }));
    const baseSeeds = (Array.isArray(seedsOverride) && seedsOverride.length) ? seedsOverride : Array.from({ length: replicates }, (_, i) => i);

    fs.mkdirSync(sweepDir, { recursive: true });
    const log = (m) => {
        const line = `[${new Date().toISOString()}] ${m}`;
        console.log(line);
        fs.appendFileSync(path.join(sweepDir, 'progress.log'), line + '\n');
    };

    // Independent work units = (config, seed-chunk). File existence = "done".
    // Seed-major ordering: cover every config at a given seed-chunk before
    // advancing to the next chunk, so a partial or interrupted run still spans
    // all configs (at fewer replicates) and yields a usable -- if lower-power --
    // Pareto frontier, rather than completing only the first few configs.
    const units = [];
    for (let i = 0; i < baseSeeds.length; i += chunkSize) {
        const chunk = baseSeeds.slice(i, i + chunkSize);
        for (const config of targetConfigs) {
            const file = path.join(sweepDir, `cfg${config.id}_s${chunk[0]}-${chunk[chunk.length - 1]}.csv`);
            units.push({ config, seeds: chunk, file });
        }
    }
    const pending = units.filter((u) => !fs.existsSync(u.file));
    log(`sweep '${path.basename(sweepDir)}': ${units.length} units, ${units.length - pending.length} done, ${pending.length} pending; concurrency=${concurrency}, chunk=${chunkSize}, configs=${targetConfigs.length}, replicates=${baseSeeds.length}`);

    let done = 0, failed = 0;
    const failedUnits = [];
    const runUnit = async (u) => {
        const label = `cfg${u.config.id}[${u.config.variant || 'grid'}] s${u.seeds[0]}-${u.seeds[u.seeds.length - 1]}`;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const t0 = Date.now();
                const raw = await runDriverAsync(u.config, u.seeds);
                const rows = raw.map((r) => parBuildRow(u.config, r.seed, evaluateAll(u.config, r.seasonLog)));
                fs.writeFileSync(u.file + '.tmp', rows.join('\n') + '\n');
                fs.renameSync(u.file + '.tmp', u.file); // atomic: a partial file never looks "done"
                done++;
                log(`OK   ${label} (${((Date.now() - t0) / 1000 / 60).toFixed(1)}min)  [${done}/${pending.length} done, ${failed} failed]`);
                return;
            } catch (e) {
                if (attempt === 2) { failed++; failedUnits.push(label); log(`FAIL ${label}: ${e.message}`); }
            }
        }
    };

    const queue = pending.slice();
    const nWorkers = Math.max(1, Math.min(concurrency, queue.length));
    // Desynchronize memory peaks. A full-engine unit holds ~5GB at its season-30
    // peak, so N units started together exhaust RAM when those peaks coincide
    // (3 simultaneous peaks = ~15GB demanded faster than the OS can evict cache
    // on a 48GB box also running apps -> mid-sim allocation throw, no output).
    // Spreading worker starts across ~one unit-time keeps roughly one unit near
    // its peak at a time, so the same concurrency fits with comfortable headroom.
    const NOMINAL_UNIT_MS = 13 * 60 * 1000;
    const staggerMs = nWorkers > 1 ? Math.round(NOMINAL_UNIT_MS / nWorkers) : 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const workers = Array.from({ length: nWorkers }, async (_, k) => {
        if (staggerMs > 0 && k > 0) {
            log(`worker ${k}: staggered start in ${Math.round((k * staggerMs) / 1000)}s (desync memory peaks)`);
            await sleep(k * staggerMs);
        }
        while (queue.length) await runUnit(queue.shift());
    });
    await Promise.all(workers);

    // Concatenate completed units into the master CSV (idempotent; reflects all
    // units done so far, so it is also valid after a partial/resumed run).
    const master = path.join(sweepDir, 'sweep.csv');
    const allRows = [PAR_CSV_HEADER.join(',')];
    for (const u of units) {
        if (fs.existsSync(u.file)) allRows.push(fs.readFileSync(u.file, 'utf8').trim());
    }
    fs.writeFileSync(master, allRows.join('\n') + '\n');
    log(`DONE: ${done} run this pass, ${failed} failed, ${allRows.length - 1} total rows -> ${master}`);
    if (failed) log(`Re-run the SAME command to retry ${failed} failed unit(s): ${failedUnits.join('; ')}`);
}

// =============================================================================
// 5. CLI.
// =============================================================================

function parseArgs(argv) {
    const args = { mode: 'normal', configIds: 'all', replicates: 1, useStub: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--smoke') args.mode = 'smoke';
        else if (argv[i] === '--full') args.mode = 'full';
        else if (argv[i] === '--stub') args.useStub = true;
        else if (argv[i] === '--config-id') {
            const v = argv[++i];
            args.configIds = (v === 'all') ? 'all' : [parseInt(v, 10)];
        }
        else if (argv[i] === '--replicates') args.replicates = parseInt(argv[++i], 10);
        else if (argv[i] === '--seasons') args.seasonsOverride = parseInt(argv[++i], 10);
        else if (argv[i] === '--seeds') {
            // Comma-separated list of integer seeds, e.g. --seeds 42,43,44,45,46
            args.seeds = argv[++i].split(',').map((s) => parseInt(s, 10));
            if (args.seeds.some(Number.isNaN)) {
                throw new Error(`--seeds expected a comma-separated integer list, got '${argv[i]}'`);
            }
            // If --replicates not separately set, infer it from the seed count.
            if (args.replicates === 1 || args.replicates === undefined) {
                args.replicates = args.seeds.length;
            }
        }
        else if (argv[i] === '--out') args.outPath = argv[++i];
        else if (argv[i] === '--parallel') args.parallel = true;
        else if (argv[i] === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
        else if (argv[i] === '--chunk-size') args.chunkSize = parseInt(argv[++i], 10);
        else if (argv[i] === '--name') args.name = argv[++i];
    }
    return args;
}

if (require.main === module) {
    const args = parseArgs(process.argv);
    const gridPath = path.join(__dirname, 'dial_grid.json');
    const outPath = args.outPath || path.join(__dirname, 'runs', `sweep_${args.mode}_${Date.now()}.csv`);

    let replicates = args.replicates;
    if (args.mode === 'full' && !args.seeds) replicates = 50;
    if (args.mode === 'smoke' && !args.seeds) replicates = 1;
    // For smoke runs, default to 30-year horizon (per Track B smoke spec).
    // For full runs, dial_grid.json provides 50; sensitivity sweeps override.
    if (args.mode === 'smoke' && args.seasonsOverride === undefined) {
        args.seasonsOverride = 30;
    }

    if (args.parallel) {
        // Resumable, parallel, crash/sleep-safe path for the long full-engine sweep.
        const name = args.name || `sweep_${Date.now()}`;
        const sweepDir = path.join(__dirname, 'runs', name);
        runSweepParallel({
            gridPath,
            sweepDir,
            configIdsToRun: args.configIds,
            replicates,
            seasonsOverride: args.seasonsOverride,
            seeds: args.seeds,
            concurrency: args.concurrency || 12,
            chunkSize: args.chunkSize || 5,
        }).catch((e) => {
            console.error(`sweep failed: ${e.stack || e.message}`);
            process.exit(1);
        });
    } else {
        runSweep({
            gridPath,
            outPath,
            configIdsToRun: args.configIds,
            replicates,
            mode: args.mode,
            useStub: args.useStub,
            seasonsOverride: args.seasonsOverride,
            seeds: args.seeds,
        });
    }
}

module.exports = {
    loadGrid,
    runZengmSeasonReal,
    runZengmSeasonsRealBatch,
    runZengmSeasonStub,
    runSweep,
    runSweepParallel,
    runDriverAsync,
};
