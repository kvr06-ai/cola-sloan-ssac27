# Rebuild note (2026-06-16)

This harness was migrated here from `cola-manipulation-bound/scripts/basketball_gm_sweep`
(older work) so the SSAC27 simulations live with the SSAC27 paper. The engine
fork (`zengm-fork`, its own ~1GB git repo) was moved into `harness/zengm-fork`;
a back-symlink remains at the old path so the retired grid sweep still resolves.
Project context, the precise core outcome, and the full rebuild plan live in the
collaboration doc (Phase 22 / Changelog v69); this file is operational only.

What changed from the migrated harness:
- `objectives.js` no longer emits the analytic `manipulation_gain_pct` (a closed
  form in |E| whose uncapped Classic value ~29% contradicts the ~4% Theorem-1
  bound). Manipulation is now MEASURED by a simulated manipulator. `sweep.js`
  CSV schemas dropped the five manipulation/per-series columns to match.
- The grid sweep below (E x C x S, W frozen) is RETIRED. The active work is the
  draft-to-outcome channel probe, then a sweep over the lottery weighting W.

Layout and workflow:
- `*.test.ts` here are editable MASTERS. They import `../worker/...`, so they run
  only from inside `zengm-fork/src/test/`. Edit a master, then `./deploy.sh` to
  sync it into the fork before running.
- One-off engine check (3-season scaffold):
  `cd zengm-fork && COLA_SPIKE=1 COLA_DRIVER_SEASONS=3 ./node_modules/.bin/vitest --run --project basketball src/test/colaFullEngineDriver.test.ts`
- Draft-to-outcome channel probe (random draft order, 12 leagues x 15 seasons) + analysis:
  `./deploy.sh && caffeinate -is ./probe_run.sh 15 12 && node channel_probe.js runs/probe/probe_c*.json --lag 3`
  Result (channel verified alive): folded into `../cola-basketball-gm-testbed.html` §3.

---

# Basketball-GM COLA Sweep (Track B Empirical Testbed)

This directory is the empirical anchor for the MIT Sloan Sports Analytics
Conference (SSAC27, March 2027) paper submission. It runs simulations
against the ZenGM Basketball-GM engine — a public single-player NBA
simulator that already implements the COLA draft type — to compute Pareto
frontiers across the seven-dial configuration space defined in
`paper/sections/03-cola-family.tex` §3.1.2 (Definition 2).

## Why Basketball-GM

Prof. Highley's guidance, 2026-05-26: *"we could use [Basketball-GM] to
optimize for various parameters."* Primary objective per the same
exchange: *minimize max years between conference finals appearances*.

ZenGM is the only publicly available NBA simulator with COLA implemented
out of the box. Reference: <https://zengm.com/blog/2026/02/cola-draft-type/>.
Our fork: <https://github.com/kvr06-ai/zengm> (default branch unchanged this
session).

## Architecture

```
basketball_gm_sweep/
├── README.md                       # this file
├── DIAL_MAPPING.md                 # zengm internals -> 7-dial taxonomy
├── ASSUMPTIONS.md                  # comprehensive testbed assumptions
├── ASSUMPTIONS_FOR_HIGHLEY.md      # distilled, policy-relevant assumptions
├── dial_grid.json                  # 48-configuration grid spec
├── sweep.js                        # main driver (loads grid, invokes engine, writes CSV)
├── objectives.js                   # primary + 3 secondary objective functions
├── colaSweepDriver.test.ts         # versioned copy of the zengm-side driver
├── zengm-fork/                     # local clone of kvr06-ai/zengm (GITIGNORED)
│   └── src/worker/core/draft/
│       └── colaSweepDriver.test.ts # driver location at runtime (synced from above)
└── runs/                           # CSV outputs per sweep run (GITIGNORED)
```

The driver test file (`colaSweepDriver.test.ts`) is committed at the parent
level as a versioned copy; at run time it must live inside the zengm-fork at
`zengm-fork/src/worker/core/draft/colaSweepDriver.test.ts` for vitest to
discover it (the project includes/excludes are anchored to the fork's source
tree). Re-clone protocol: after cloning zengm-fork, copy the parent-level
driver into the fork.

## Dial grid

48 configurations swept over:

| Dial | Values | Count |
|---|---|---|
| E (eligibility) | 14, 22, 16-tiered | 3 |
| C (cap) | null, 100, 150, 200 | 4 |
| S (carry-over scope) | single-season, unbounded, bounded-30yr, reset-on-championship | 4 |

Held at Classic COLA defaults: Δ = 1000, ρ = playoff-success-step,
W = uniform, T = coin-flip.

Default replicates: **50 seasons per configuration**.
Sensitivity check: a 4-config subset re-run at 30 and 100 seasons to
verify Pareto frontier stability.

Full sweep at the default rate: 48 × 50 = 2,400 simulated seasons.

## Objectives

Per `objectives.js`:

1. **`maxYearsBetweenConferenceFinals(seasonLog)`** — primary objective
   per Highley. For each franchise, longest consecutive run of seasons
   without reaching the conference finals. Return the maximum over all
   franchises. **Lower is better** (more equitable parity).

2. **`manipulationGainUpperBound(config)`** — Theorem 1 closed-form bound
   on the manipulator's gain. Analytical (no simulation needed). For
   capped configurations, switches to Lemma 2 (per-series cost).

3. **`perSeriesCost(config)`** — Lemma 2 ceiling: `0.2 · C` (typical) or
   `0.3 · C` (play-in). Null for uncapped configurations.

4. **`rankOneToFiveSpread(seasonLog)`** — expected-pick spread between
   the worst team and the 5th-worst team over the simulation horizon. A
   small spread implies tanking yields little marginal advantage
   (anti-tanking strength proxy).

## How to run

```bash
# Smoke test (one config, 30 simulated seasons, REAL engine)
node sweep.js --smoke --config-id 1

# Smoke test with synthetic-season stub (fast pipeline check)
node sweep.js --smoke --stub --config-id 1

# Single configuration (config_id = N) for `R` replicates
node sweep.js --config-id 0 --replicates 50

# Full sweep (all 48 configs, 50 replicates each = 2,400 simulated seasons)
node sweep.js --full
```

Output: CSV per run in `runs/sweep_${mode}_${timestamp}.csv`. One row per
`(config_id, replicate_id)`.

## Status (Track B real-engine driver, 2026-05-26)

| Component | Status |
|---|---|
| Grid expansion (`dial_grid.json` → 48 explicit configs) | Implemented |
| Objective functions (`objectives.js`) | Implemented |
| CSV aggregator | Implemented |
| zengm headless invocation | **REAL** — `zengm-fork/src/worker/core/draft/colaSweepDriver.test.ts` |
| Runtime dial application (E, C, S) | Implemented in driver (no source patches needed) |
| Smoke test (Classic, 30 seasons, 1 replicate) | Passing |
| Full sweep (48 × 50) | Ready; cost ≈ 48×50×3s ≈ 2hr at current per-replicate overhead |

## Engine driver details

The driver lives at `zengm-fork/src/worker/core/draft/colaSweepDriver.test.ts`
and is invoked as a vitest subprocess. It uses ZenGM's own test-setup
file (`zengm-fork/src/test/setup.ts`) which provides `fake-indexeddb`
and mocks `self`/`window`. The driver:

1. Bootstraps a 30-team league directly into the mocked IDB cache
   (bypassing `createLeague()`, which the Track B agent believed was
   browser-coupled; the Full-engine spike section below disproved that).
2. For each simulated season:
   - Synthesizes wins + playoff bracket outcomes (strength-weighted).
   - Applies carry-over scope (dial S) by zeroing/clamping team.cola.
   - Applies eligibility mask (dial E) by zeroing R1-loser team.cola.
   - Calls **real ZenGM** `cola.updateLotteryChancesAfterPlayoffs()`.
   - Applies cap clamp (dial C) by clipping team.cola to ≤ C.
   - Calls **real ZenGM** `draft.genOrder(mock=true)` for the lottery.
   - Calls **real ZenGM** `cola.updateLotteryChancesAfterLottery(top4)`.
   - Updates each team's persistent strength via the Markov transition
     below (the prior season's draft pick feeds the strength update).
3. Returns the per-season `{tid, conf, wins, playoffRoundsWon, draftPick,
   cola}` array as JSON.

### Simulation model

Team strength persists across seasons via a Markov process tied to
draft outcomes. For each team:

```
strength_{t+1} = clip(
    rho * strength_t                       # persistence
    + (1 - rho) * mu                       # mean reversion toward parity
    + alpha * pick_value(draft_pick_t)     # draft-pick boost
    + eps_t,                               # annual shock
    0, 1
)
eps_t ~ Normal(0, sigma^2)
pick_value(p) = max(0, (16 - p) / 15)      # pick 1 -> 1.0, pick 15 -> 0, 16+ -> 0
```

Tuned parameters (set in `colaSweepDriver.test.ts`):

| Param | Value | Role |
|---|---|---|
| `rho`   | 0.9  | persistence / autocorrelation |
| `mu`    | 0.5  | long-run parity mean |
| `alpha` | 0.15 | per-draft impact |
| `sigma` | 0.05 | annual shock standard deviation |

Initial state: `strength_0 ~ Uniform[0.3, 0.7]` per team.

Calibration philosophy: parameters were chosen for plausibility and
tuned so the smoke test's per-team CF-gap distribution disperses
relative to the prior i.i.d. uniform baseline (see `ASSUMPTIONS.md` Z-2
for the tuning trace). They are not fit to historical NBA team-strength
trajectories; sensitivity analysis on `(rho, alpha, sigma)` is future
work. The model preserves the feedback loop the primary objective
measures (lottery position → draft pick → next-season strength) without
claiming quantitative accuracy.

See `ASSUMPTIONS.md` for the full list of engine/dial/objective
assumptions and `ASSUMPTIONS_FOR_HIGHLEY.md` for the policy-relevant
distillation.

## Full-engine spike (2026-06-10)

The Track B testbed above synthesizes regular-season wins and team strength
to keep the lottery question fast. A reviewer (Prof. Highley) asked for the
validity gains ZenGM's full engine adds: per-game simulation, AI GMs,
contracts, and city-size effects. A spike confirmed the full engine runs
headless in Node, so a higher-fidelity validation pass is viable without a
browser. Two artifacts (mirrored into `zengm-fork/src/test/` to run, like
the driver above):

| File | Role |
|---|---|
| `colaFullEngineSpike.test.ts` | Drives the real `league.createStream()` (the path the UI uses) against `fake-indexeddb/auto`. Builds a complete random league headless. |
| `colaSimBenchmark.test.ts` | Drives the per-game engine (regular season, playoffs, draft, free agency, all AI-GM-controlled) via the engine's own `autoPlayUntil` self-continuation, and benchmarks sec/season. |

Findings:

- The "createLeague is browser-coupled" assumption is false. The only
  missing piece in Node was a global `indexedDB`, supplied by
  `fake-indexeddb/auto` in one import. A random league's input stream is
  empty (`createStreamFromLeagueObject({})`); players, contracts, and
  rosters are generated after the stream drains, in `afterDBStream`.
- `createStream` builds a full league in ~1.6 s with all four flagged
  features: 750 players (390 rostered, 13 per team), 390/390 valid
  contracts, 30/30 AI-GM strategies, and 24 distinct city populations
  (1.6 to 21.5 million).
- The per-game engine simulates full 82-game seasons headless at roughly
  9 to 20 sec/season on an M3 Max (per-season cost drifts up with the
  accumulating retired-player pool; mitigable with ZenGM's `deleteOldData`).
- Compute envelope: the full-engine validation sweep (48 grid configs + 2
  named anchors = 50 configs, 75,000 seasons) is ~18 hr pruned / ~45 hr
  un-pruned at 12-way parallelism. No cloud.

Run (both tests are env-gated so a bare `npm test` stays fast):

```
# from zengm-fork/
COLA_SPIKE=1 npx vitest --run src/test/colaFullEngineSpike.test.ts --project basketball
COLA_SPIKE=1 COLA_BENCH_SEASONS=5 npx vitest --run src/test/colaSimBenchmark.test.ts --project basketball
```

Validation design (updated 2026-06-11, per co-author review): the
full-engine sweep runs ALL 48 grid configurations plus two off-grid named
anchors (Countdown COLA and Beckett COLA), 50 configs × 50 replicates × 30
seasons = 75,000 seasons, and re-derives the Pareto frontier from scratch.
The synthesized frontier above becomes a prediction to score, not an
assumption (the earlier 9-config hybrid plan validated only the predicted
frontier and could not surface a config the cheap model wrongly excluded).
Variant decisions per the co-author: Simple Lottery skipped (mostly mirrors
Simple); McCarty, 2-Year 22, and Flat 10+R excluded (not endorsed).
Countdown ports from the parent repo's `cola-engine.js`
(`computeCountdownCOLA`, 100k-trial MC audit); Beckett implements from the
2026-04-10 Substack spec (drought-gated McCarty-number raffle; uncapped
pending co-author confirmation). Both anchors use the same driver hook:
compute the draft order driver-side, inject before ZenGM's draft phase.
See `dial_grid.json` `_named_anchors`.

Next: build the full-engine COLA driver (the Track B driver's dial-patching
and lottery hooks, but with real createStream + per-game sim + per-season
pruning + the draft-order injection hook), run the formal pilot, then the
full 50-config sweep.

## Next-session work

1. **Lottery-draw determinism.** ZenGM's lottery draw uses `randInt` from
   `src/common/random.ts`, which calls Node's `Math.random` and is not
   seeded by our driver. To make lottery outcomes reproducible we need
   to override ZenGM's random source via dependency injection.

2. **Replicate batching.** Current overhead is ~3 s per replicate
   (vitest startup + driver). For the headline 48 × 50 run, batching
   multiple replicates per subprocess would cut wall time materially.

3. **Per-config patch files.** If we later need to sweep ρ / W / T,
   we'll need to emit per-config patches under `patches/` and apply via
   `git apply` (currently runtime patches in the driver cover E, C, S).

## License reminder

`zengm-fork/` is a private local clone of a source-available repository.
The ZenGM license permits local private use and editing; it does NOT
permit hosting a modified playable version or distributing installers.
Our research use (headless figure-generation testbed) is permitted.

## Related files in the parent repo

| File | Role |
|---|---|
| `paper/sections/03-cola-family.tex` | §3.1.2 Definition 2 (seven dials) |
| `docs/js/cola-engine.js` | Our own JavaScript COLA engine; cross-check reference |
| `scripts/audit_dial_taxonomy.js` | Audits paper-cited dial values against `cola-engine.js` (code style template for this directory) |
