# ZenGM COLA Dial Mapping

This document maps the seven COLA dials (Definition 2, paper §3.1.2) onto
ZenGM Basketball-GM's internal COLA implementation. It identifies which
dials are exposed through configuration (`gameAttributes` or constants) and
which require source modifications to sweep.

## Source files in the cloned `zengm-fork`

| File | Role |
|---|---|
| `src/worker/core/draft/cola.ts` | Core COLA lottery-index update logic (`updateLotteryChancesAfterPlayoffs`, `updateLotteryChancesAfterLottery`, `initializeCola`, `disableCola`). 225 lines. |
| `src/worker/core/draft/genOrder.ts` | Draft-order generation. Branches on `draftType === "cola"`. |
| `src/common/constants.ts` | `COLA_ALPHA = 1000`, `COLA_OPT_OUT_PENALTY = 2000`. |
| `src/common/types.ts` | `DraftType` union (includes `"cola"`); `Team.cola?: number`, `Team.colaOptOut?: boolean`. |
| `src/common/defaultGameAttributes.ts` | Default `gameAttributes` (where `draftType` lives). |
| `src/worker/core/league/setGameAttributes.ts` | Initialises COLA when `draftType` is set to `"cola"`. |

## ZenGM's COLA defaults (corresponds to paper's Classic COLA)

| Dial | Paper's Classic | ZenGM constant / code | Match? |
|---|---|---|---|
| E (eligibility) | 14 non-playoff teams | `getNumLotteryTeams()` returns `numActiveTeams - numPlayoffTeams`, where playoff teams = all but the final 3 rounds (i.e., R2+ winners → 8 teams). Net: 22 teams in default NBA config (14 non-playoff + 8 R1 losers). | **Mismatch**: ZenGM uses 22-team pool (matches Simple/Capped), not 14. See note below. |
| Δ (increment) | α = 1000 per missed playoff | `COLA_ALPHA = 1000`; applied per non-CF-or-better team in `updateLotteryChancesAfterPlayoffs`. | Match (numerically), but applied to a 22-team pool, not 14. |
| ρ (diminishment) | Playoff: {1.0, 0.75, 0.5, 0.25, 0}; Draft: {1.0, 0.75, 0.5, 0.25} | `PLAYOFF_FACTORS = [0.75, 0.5, 0.25, 0]` (applied as multipliers, indexed by `playoffRoundsWon - offset`; champion implicitly = 0 via array bounds). `DRAFT_LOTTERY_FACTORS = [0, 0.25, 0.5, 0.75]` for picks 1–4. | Match in spirit, but encoded as multiplicative residual `(1 - ρ)` not `ρ`. Champion's residual = 0 (full reset). |
| W (lottery weighting) | L_i / P for picks 1–4, rank for 5+ | `genOrder.ts` uses chance-weighted sampling for the lottery range (picks 1–4 by default) and then deterministic rank order for the rest. | Match (Classic configuration). |
| C (cap) | ∞ for Classic | No cap in ZenGM source: `t.cola += COLA_ALPHA` is unclamped. | Match (∞). |
| S (carry-over scope) | unbounded multi-year | `initializeCola()` looks back 20 seasons and re-derives current index from history. After init, accumulates without bound. | Match (effectively unbounded; 20-year backfill window is for league-import, not steady-state behavior). |
| T (tiebreak) | subsumed by W (random draw) | `divideChancesOverTiedTeams.ts` distributes chances across tied teams; ZenGM's lottery draw resolves the tie randomly. | Match. |

### Eligibility-pool subtlety

ZenGM's `getNumLotteryTeams()` is hardcoded to include the "final 3 rounds" of
playoff bracket as non-lottery, which for a 30-team NBA league = 8 teams
non-lottery (R2+ winners), giving **22 teams in the lottery**. This is the
22-team pool that Simple, Simple Lottery, Countdown, and Capped variants share
in the paper — *not* the 14-team Classic pool.

To get the paper's 14-team Classic COLA pool, modify
`src/worker/core/draft/cola.ts` lines 14–28 (`getNumLotteryTeams`) and the
TODO comment around line 134 of `genOrder.ts` that hardcodes COLA to be
"before the last 3 rounds of playoffs."

## Dial exposure summary

| Dial | Exposed configuration | Modification required? |
|---|---|---|
| E | None (hardcoded in `getNumLotteryTeams`) | **Yes** — patch `getNumLotteryTeams` and the genOrder.ts branch on `draftType === "cola"`. For the 16-tiered 3-2-1 option, a new branch would be needed. |
| Δ | `COLA_ALPHA` constant | Partial — to vary α per sweep, monkey-patch the export or modify `constants.ts`. Wins-based Δ (Capped) requires full rewrite of `updateLotteryChancesAfterPlayoffs`. |
| ρ | `PLAYOFF_FACTORS`, `DRAFT_LOTTERY_FACTORS` arrays inside `cola.ts` (not exported) | **Yes** — these are file-local; the sweep driver must either patch the file or fork the function. |
| W | Encoded in `genOrder.ts` chance-allocation logic | **Yes** — alternate weighting rules require source modification. |
| C | No cap support in ZenGM | **Yes** — add `Math.min(t.cola, C)` in `updateLotteryChancesAfterPlayoffs` after the `+= COLA_ALPHA` step, and in `updateLotteryChancesAfterLottery`. |
| S | `initializeCola` looks back 20 seasons; runtime accumulates unbounded | **Yes** — single-season requires zeroing index each year; bounded-30yr needs a sliding window; reset-on-championship needs an event hook in playoffs phase. |
| T | Subsumed by lottery draw randomness | None for random; deterministic tiebreaks would need a new branch. |

**Net assessment**: only the `draftType` selection (binary: COLA or not-COLA)
is exposed via `gameAttributes`. Every other dial — `E`, `C`, `S`, `W`, `ρ`,
`Δ` — requires patching `src/worker/core/draft/cola.ts`,
`src/worker/core/draft/genOrder.ts`, or `src/common/constants.ts` at sweep
time. The cleanest mechanism is a generated patch file per configuration
(`scripts/basketball_gm_sweep/patches/config_${id}.patch`) applied via
`git apply` before each sweep step, then reverted.

## Headless invocation paths

The zengm engine runs in a browser Web Worker. To drive it from Node for
2,400 simulated seasons, three approaches are viable (ranked by feasibility):

1. **Vitest node-environment driver** (recommended for scaffold).
   ZenGM's `vitest.config.ts` already runs basketball worker tests in Node
   via `setupFiles: ["./src/test/setup.ts", "./src/worker/index.ts"]`. The
   setup file (`src/test/setup.ts`) installs `fake-indexeddb`, mocks `fetch`
   to read from disk, and aliases `globalThis.self/window`. This exposes
   `self.bbgm` (the full worker API) in Node. Existing test
   `src/worker/core/draft/genOrderNBA.test.ts` exercises the lottery via
   `getDraftTids()` against a mocked IDB league.
   
   Gap: existing tests do not run *full* seasons (regular-season schedule
   simulation + playoff bracket + draft + free agency). Driving the engine
   through a full annual cycle requires invoking the worker's phase-stepping
   API (`actions.playAmount`, `phase.newPhase`, etc.). This ticket landed
   2026-06-10: `colaFullEngineSpike.test.ts` and `colaSimBenchmark.test.ts`
   drive full annual cycles headless via the engine's own autoPlay
   self-continuation (see README.md "Full-engine spike").

2. **Playwright e2e driver**. Spin up `node --run dev`, drive the UI through
   Playwright, intercept league state via `window` globals. Higher per-season
   overhead but no source modifications needed for `draftType`. ZenGM's
   `postinstall` already runs `playwright install`.

3. **Engine extraction**. Peel the simulation core into a standalone Node
   module. Cleanest long-term path; requires meaningful refactoring of
   ZenGM internals; substantial engineering ticket.

## Engineering ticket for next session

Build a `runOneSeason(config, seed) -> seasonLog` driver in Node:

1. Use the vitest setup pattern: import `fake-indexeddb` shim and load
   `src/worker/index.ts` to populate `self.bbgm`.
2. Create a fresh league via `self.bbgm.api.main.createLeague(...)` with
   `draftType: "cola"` and the patched `cola.ts` for the target config.
3. Step through `numSeasons` annual cycles by calling
   `self.bbgm.actions.playAmount("untilDraft")` -> capture state ->
   `playAmount("untilPlayoffs")` -> capture -> `playAmount("untilEnd")`.
4. After each season, extract per-team `{tid, wins, playoffRoundsWon,
   draftPick, cola}` from the worker's `teamSeasons` cache and append to
   `seasonLog`.
5. Tear down the league between configs to ensure independence.

## License reminder

ZenGM is source-available (not GPL/MIT). The license permits local private
use ("Run it locally") and editing. We may NOT host a modified version
publicly, distribute installers, or operate a competing playable instance.
Our use (private headless research testbed for paper figures) is permitted.
Patches applied for sweeps stay in the local clone; we do not redistribute
modified zengm binaries or playable forks.
