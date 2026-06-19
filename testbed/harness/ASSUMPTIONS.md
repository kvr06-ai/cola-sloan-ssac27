# Testbed Assumptions (Comprehensive)

Date: 2026-05-26.
Companion to `sweep.js`, `colaSweepDriver.test.ts`, `objectives.js`,
`dial_grid.json`, `DIAL_MAPPING.md`.

This file enumerates every assumption baked into the Track B testbed. Each
item: the assumption, the reason, the source file/line where it lives, and
any deviation from Highley's published spec.

The distilled, policy-relevant subset is in `ASSUMPTIONS_FOR_HIGHLEY.md` —
this file is the exhaustive reference for internal review.

**Status note (2026-06-10).** A full-engine viability spike
(`colaFullEngineSpike.test.ts`, `colaSimBenchmark.test.ts`; findings in
README.md "Full-engine spike") disproved the browser-coupling premise in
Z-2/Z-3: ZenGM's real `createStream()` league creation and per-game
season engine run headless in Node against `fake-indexeddb`. The
synthesized testbed below remains the engine of the 48-configuration
screen. Validation design updated 2026-06-11 per co-author review: the
full engine re-runs ALL 48 grid configurations plus two off-grid named
anchors (Countdown COLA, Beckett COLA; see `dial_grid.json`
`_named_anchors`), 75,000 seasons total, and re-derives the Pareto
frontier from scratch, exercising for real what Z-2, Z-3, Z-4, Z-10,
Z-11, and Z-12 bypass. The earlier 9-config hybrid plan (validate only
the predicted Pareto set) was superseded: frontier membership is the
hypothesis under test, not a prior. The full-engine driver will carry
its own assumptions section when it lands. Corrections of 2026-06-10
are marked [CORRECTED 2026-06-10] inline (Z-3, S-1, S-2); Z-2's
cross-reference to Z-3 was updated to match.

**Full-engine driver, step 2 modeling choices (2026-06-11).** The
`colaFullEngineDriver.test.ts` driver (a sweep.js drop-in under
COLA_FULL_ENGINE=1) adds, beyond the cola dial mechanics:

- **FE-1. 16-tiered pool = per-conference seeds 8-15 (record-based).** The
  3-2-1 proposal pool is modeled as the bottom 8 by regular-season record in
  each conference (= 10 non-playoff-non-play-in [seeds 11-15] + 4 record-9/10
  [seeds 9-10] + 2 7v8-losers [proxied by the 8-seed]). This is the
  per-conference 3-2-1 structure, more faithful than Track B's "16 worst
  overall" (B-2). The exact 7v8-game loser (vs the 8-seed proxy) is available
  from `playoffSeries.playIns` / `getTidPlayIns`; using it is a 2-team,
  play-in-upset-only refinement, deferred.

- **FE-2. Named anchors (Countdown, Beckett) track drought in the driver and
  inject a computed draft order over the engine's lottery.** Countdown drought
  = years since a playoff series win OR top-3 pick (port of cola-engine.js
  computeSimpleCOLA); McCarty = drought x wins; survivor elimination-pool draw.
  Beckett drought = years since a #1 pick OR top-6 seed OR playoff series win;
  eligible = drought >= 2; entries = drought x wins; top-4 raffled, rest by
  entries; uncapped (cap pending Highley). "Top-6 seed" is proxied by
  top-6-by-wins within conference. Injection rewrites the round-1 `pick`
  numbers; determinism is per (config.id, seed) via the Math.random override.

- **FE-3. [RESOLVED 2026-06-13] The manipulation-gain secondary objective is NOT
  well-defined for the non-cola anchors, so it is blanked (N/A), not faked.**
  The cola manipulation bound is a closed form in |E|; it has no meaning for
  Countdown/Beckett. objectives.js now returns `gain_pct = bound = null`,
  `regime = "n/a"` for any `variant` config, so the CSV manipulation cells are
  empty for the anchors and they are neither credited nor penalized on that axis
  of the Pareto frontier. Their PRIMARY objective (max years between conference
  finals) and rank-spread are computed from the real seasonLog and are
  meaningful. Per-series-cost is already null (anchors are uncapped, C=null).
  Surface to Highley with the results: the anchors are "not applicable" on the
  manipulation axis by construction.

- **FE-2 cap, RESOLVED 2026-06-13: Beckett runs UNCAPPED.** Our 2026-06-11 reply
  stated we would implement Beckett uncapped unless Highley flagged a cap; he did
  not reply, so per the opt-out posture uncapped is confirmed for the sweep.

---

## 1. ZenGM Engine Assumptions

**Z-1. Lottery-pool default is 22 teams, not 14.**
ZenGM's `getNumLotteryTeams()` (zengm-fork/src/worker/core/draft/cola.ts:15-28)
returns `numActiveTeams - 8` for a 4-round playoff bracket — i.e. all teams
that did not win at least one round are eligible. For a 30-team league this
is 22 teams (14 non-playoff + 8 first-round losers), matching the paper's
**Simple/Capped** pool, not **Classic's 14**. To recover the 14-team Classic
pool we apply an eligibility mask in the driver (`applyEligibilityMask` in
colaSweepDriver.test.ts:194) that zeros the COLA index of R1-loser teams
before the lottery draw, making them effectively ineligible while leaving
ZenGM's source untouched.

**Z-2. Team-strength model is a persistent Markov process tied to draft outcomes.**
We do not run ZenGM's full game-by-game simulation in the Node driver (a
speed-and-scale choice; the feasibility rationale this item originally
cited was disproven 2026-06-10, see Z-3). Instead, we
synthesize per-season win records from a per-team strength variable that
persists across seasons (`simulateSeasonOutcomes` +
`transitionStrength` in colaSweepDriver.test.ts). The transition is

    strength_{t+1} = clip(rho * strength_t + (1 - rho) * mu
                          + alpha * pick_value(draft_pick_t)
                          + eps_t,
                          0, 1)

with `eps_t ~ Normal(0, sigma^2)`. Pick value is monotone-decreasing in
pick number, `pick_value(p) = max(0, (16 - p) / 15)` (pick 1 contributes
full alpha, pick 15 contributes zero, picks 16+ contribute zero). Tuned
parameters: rho=0.9 (persistence), mu=0.5 (parity mean), alpha=0.15
(per-draft impact), sigma=0.05 (annual shock). Initial strength
~ Uniform[0.3, 0.7]. Strength is converted to wins around a mean of 41
with a ±18-win tilt; bracket outcomes are sampled with
`P(A beats B) = strength_A / (strength_A + strength_B)`.

Rationale: the prior i.i.d. Uniform[0.2, 0.6] refresh broke the feedback
loop the primary objective (max years between conference finals) is
designed to measure. With i.i.d. refresh, every franchise reaches the CF
across a 30-season horizon by chance, and the per-team CF-count
distribution is tight. The Markov model restores the link between draft
outcomes and subsequent team quality, which is the mechanism COLA is
designed to manage. Calibration philosophy: parameters chosen for
plausibility, not exact NBA-data fit. Documented limitations in L-Z2 below.

The model still omits ZenGM's contracts/trades/injuries, which the paper's
dial space does not control.

**Z-3. [CORRECTED 2026-06-10] Regular-season game simulation is bypassed
by choice, not necessity.**
Original claim: `actions.playAmount('untilDraft')` requires a fully
constructed league built via `createLeague()`, a browser-coupled path
involving leagueFile upload streams not viable in Node without porting
substantial browser globals. The 2026-06-10 spike disproved this: with
`fake-indexeddb/auto` providing a global IndexedDB, the real
`league.createStream()` builds a complete league headless in ~1.6 s
(750 players, full rosters, contracts, AI-GM strategies, per-team city
populations; the random-league input stream is empty, so there is no
payload schema to port), and the per-game engine simulates full 82-game
seasons at ~10-15 s/season (see `colaFullEngineSpike.test.ts`,
`colaSimBenchmark.test.ts`, README.md "Full-engine spike"). The bypass
is retained for the 48-configuration screen because the synthesized
season costs ~3 ms vs ~10-15 s per season and the dial space controls
the lottery mechanism, not the game engine. The full engine re-runs all
48 grid configurations plus the Countdown and Beckett named anchors and
re-derives the frontier (design updated 2026-06-11; the earlier
9-config hybrid was superseded).

**Z-4. Playoff bracket: single-elimination, 8-team-per-conference NBA-style.**
We hardcode the bracket structure (1v8, 2v7, 3v6, 4v5 reseeded to single-
elim) in `simulateSeasonOutcomes` (colaSweepDriver.test.ts:121). This
matches the default ZenGM `numGamesPlayoffSeries: [7,7,7,7]` shape, and
the paper's `ρ = playoff-success-step` increment pattern. No play-in
tournament is simulated (the 16-tiered E dial is supported but not
exercised in the smoke run).

**Z-5. Default lottery weighting (W=uniform) and tiebreak (T=coin-flip)
are baked into ZenGM's cola.ts.**
We do not vary W or T in the 48-config grid. `genOrder.ts` (line 244-264)
computes lottery chances as `t.cola + addAlpha` per team and
`divideChancesOverTiedTeams` is bypassed for `draftType === "cola"`. Top-4
diminishment factors `DRAFT_LOTTERY_FACTORS = [0, 0.25, 0.5, 0.75]` and
playoff factors `PLAYOFF_FACTORS = [0.75, 0.5, 0.25, 0]` are file-local
constants in cola.ts; varying them would require source modification.

**Z-6. Champion's cola is fully reset (not just decremented).**
`PLAYOFF_FACTORS[champion_index]` indexes out of bounds (length 4, indices
0..3 for `playoffRoundsWon - offset` ∈ {0,1,2,3} → champion at index 4
returns `undefined`, falling into the increment branch). Actually wait —
cola.ts:79-84 shows champion → `factor === undefined` → goes into the
ADD-ALPHA branch. Reading more carefully: champion = `playoffRoundsWon =
numPlayoffRounds = 4`. `offset = 4 - 4 + 1 = 1`. So index = `4 - 1 = 3` →
`factor = 0` → `cola *= 0`. **The champion's cola is reset to 0.** Match
to paper's ρ_champion = 1.0 (full diminishment).

**Z-7. Top-4 lottery winners receive ZenGM-specified diminishment.**
DRAFT_LOTTERY_FACTORS = [0, 0.25, 0.5, 0.75]: 1st pick → cola *= 0,
2nd → *= 0.25, 3rd → *= 0.5, 4th → *= 0.75. Matches paper's draft-cliff
schedule.

**Z-8. League size: 30 teams.**
`bootstrapLeague` (colaSweepDriver.test.ts:225) uses
`helpers.getTeamsDefault().slice(0, 30)`. The first 30 are the ZenGM
canonical NBA team set (Atlanta first; standard conferences/divisions).
Modifying league size would change the lottery pool size (E) coupling.

**Z-9. Conference alignment: 2 conferences of 15 teams each.**
Inherited from ZenGM's default `teamsDefault`. `cid` 0 = East, 1 = West.
Bracket is per-conference (8 playoff teams per conference, conference
winner emerges).

**Z-10. Salary cap and free agency: bypassed.**
The driver does not advance the post-draft phases (free agency, contract
negotiation). Per-team `budget`/`expenses`/`revenues` are stubbed to
empty objects in `appendTeamSeasons`. This is safe: the lottery + COLA
update logic does not depend on these.

**Z-11. Draft class generation: bypassed.**
`draft.genOrder(mock=true)` returns draft-pick order but does not generate
players. The mock flag prevents `idb.cache.draftPicks.add` from persisting
results. We capture pick→tid mapping from the returned `draftPicks` array.

**Z-12. Trade engine: not simulated.**
No mid-season trades. `draftPicksIndexed[t.tid]?.[1]?.tid` check in
genOrder.ts:251 always returns `t.tid` (no traded picks).

**Z-13. ZenGM-version pin.**
The fork is `kvr06-ai/zengm@master` at the commit cloned 2026-05-26
(zengm 5.1.0 per package.json). Changes upstream to cola.ts /
genOrder.ts after this date would require re-validating Z-1..Z-12.

---

## 2. License Compliance Assumptions

**L-1. ZenGM license permits private headless research use.**
zengm-fork/LICENSE.md is a custom source-available license, not GPL/MIT.
The license permits running locally and editing for personal/research
use. We are NOT publishing the modified fork, hosting a playable
instance, or distributing installers. The patches we generate
(see DA-7) live only in the local clone.

**L-2. The fork remains private and gitignored.**
`scripts/basketball_gm_sweep/zengm-fork/` is `.gitignore`'d in the
`cola-manipulation-bound` repo. No ZenGM source is committed to public
git. We do not push to the `kvr06-ai/zengm` GitHub fork; that fork
remains an unmodified mirror.

**L-3. Aggregate research outputs are derivative work, not redistribution.**
The CSV outputs in `runs/` are objective metrics — counts, gaps, expected
picks — derived from simulation. They contain no zengm source, player
names, or proprietary fixtures. Publishing the CSVs and resulting Pareto
plots in the paper is permitted as scholarly use.

**Violation conditions (what we are NOT doing):**
- Hosting a playable web-deployed version of the modified zengm.
- Distributing installers, binaries, or playable forks publicly.
- Pushing modified zengm source to a public git remote.
- Including zengm fixtures (players, leagues) in our paper repo.

---

## 3. Dial-Grid Assumptions

**D-1. Dimensionality reduction: E × C × S = 3 × 4 × 4 = 48 configurations.**
Δ, ρ, W, T are held fixed at Classic defaults (`dial_grid.json:21-26`).
Rationale: paper §3.1.2 names E, C, S as the dials with the most
contested policy intuitions; Δ scales linearly (already established in
Theorem 1), and ρ/W/T variations require source rewrites with no
public-discourse anchor to compare against. Cross-dial sweeps (e.g.,
Δ × C interactions) are NOT explored in this grid.

**D-2. E dial values: {14, 22, "16-tiered"}.**
14 = paper's Classic. 22 = ZenGM default (= paper's Simple/Capped). 
16-tiered = paper's 3-2-1 proposal pool (10 non-playoff non-play-in + 4
record-9/10 + 2 7v8 losers). Values 15..21 are not swept — we anchor on
the policy-relevant cardinalities and trust the bound's monotone-in-E
shape (Theorem 1) for interpolation.

**D-3. C dial values: {null, 100, 150, 200}.**
null = no cap (Classic). 100 = stricter than Capped default. 150 = Capped
COLA default per Highley Substack. 200 = looser cap.

**D-4. S dial values: {single-season, unbounded, bounded-30yr,
reset-on-championship}.**
single-season = no cross-year memory (3-2-1 baseline pattern).
unbounded = Classic multi-year accumulation. bounded-30yr = sliding
30-year window. reset-on-championship = clear on title (event-based).

**D-5. Δ fixed at 1000.**
ZenGM's `COLA_ALPHA = 1000` (zengm-fork/src/common/constants.ts:14). The
absolute scale of Δ does not affect the lottery (only ratios matter); we
hold at the default for parity with Highley's framing.

**D-6. ρ fixed at "playoff-success-step".**
ZenGM's `PLAYOFF_FACTORS = [0.75, 0.5, 0.25, 0]` plus
`DRAFT_LOTTERY_FACTORS = [0, 0.25, 0.5, 0.75]`. Matches paper's Classic ρ
schedule (champion = 0 residual, monotone increasing as you exit earlier).

**D-7. W fixed at "uniform" (i.e., L_i / P chance proportional to cola).**
genOrder.ts:248-261. Picks 1-4 are sampled chance-weighted; picks 5+ are
strict rank order (lowest cola first). Matches paper's Classic W.

**D-8. T fixed at "coin-flip".**
ZenGM's lottery draw is intrinsically random when chances are tied; no
explicit tiebreak rule is exercised. Matches paper's Classic T (random
draw subsumed by W).

---

## 4. Simulation Assumptions

**S-1. [CORRECTED 2026-06-10] Horizon: 30 seasons per replicate for smoke
AND headline.**
`dial_grid.json` carries `seasons_per_config: 50`, but the shipped
2026-05-26 headline run overrode it to 30 (every row of
`runs/headline_20260526_132248/headline.csv` has seasons=30). An
earlier version of this item described a 50-season headline horizon;
no shipped run used 50. 30 years is long enough for carry-over scope
(S=bounded-30yr) to manifest, and the hybrid full-engine validation
mirrors the same 50 × 30 replicate shape.

**S-2. [CORRECTED 2026-06-10] Default replicates: 1 for smoke, 50 for headline.**
The smoke test uses 1 replicate to validate the engine path. The
shipped headline run used 50 replicates per config at the 30-season
horizon (2,400 replicates, 72,000 simulated seasons, 219 s wall time
batched); an earlier version of this item miscounted that as "2,400
total simulated seasons at the 50-season horizon". Sensitivity runs at
30 and 100 replicates (per dial_grid.json `_sensitivity_protocol`, run
over 9 configs: the 5 Pareto-optimal + 4 named variants) verified the
frontier is not a Monte Carlo artefact.

**S-3. Reproducibility: deterministic PRNG keyed by `(config_id, replicate_seed, base_seed=42)`, INCLUDING the lottery draw.**
`hashSeed(configId, replicateSeed, baseSeed)` in colaSweepDriver.test.ts.
Each (config, replicate) gets a unique 32-bit seed; mulberry32 produces
the bracket samples, strength values, AND the lottery draw.

As of 2026-05-26 the driver overrides `Math.random` for the duration of
each replicate with the same mulberry32 stream used for the rest of the
simulation (`runOneReplicate()`, try/finally-scoped). ZenGM's `randInt()`
(src/common/random.ts:32) calls `Math.random` internally, so the override
makes the lottery draw fully deterministic. The original `Math.random` is
restored at the end of each replicate so the override does not leak into
subsequent replicates batched into the same vitest subprocess (see S-5)
or into any other vitest test running in the same process.

Approach chosen (vs. alternatives):
- vi.mock on src/common/random.ts: rejected — would require modifying
  the import paths in genOrder/cola; touchier to scope per-replicate.
- Threading a seed parameter through genOrder/randInt: rejected —
  would diverge the fork from upstream ZenGM, breaking future merges.
- Math.random override: chosen — single-line patch in driver only,
  zero ZenGM source modification, replicate-scoped via try/finally.

Verification: two consecutive runs with identical (config_id,
replicate_seed) now produce bit-identical CSV rows. Confirmed
empirically on cfg_id=1, seed=42 (see commit message for the run log).

**S-5. Single replicate vs. multiple replicates per config — batched as of 2026-05-26.**
The sweep harness (`sweep.js`) now batches all replicates of a given
config into ONE vitest subprocess invocation via the
`COLA_DRIVER_REPLICATES` env var (JSON list of seeds). The driver loops
over seeds within one process, writing `[{ seed, seasonLog }, ...]` to
the output path. The ~3 s vitest startup is paid once per config
instead of once per (config, replicate). Empirical measurement at the
5-replicate verification scale: legacy per-replicate path ≈ 19 s
total (3.8 s/replicate); batched path ≈ 5.5 s total (1.1 s/replicate
amortised) — a ~3.4× speedup for cfg_1 (E=14 uncapped, 30 seasons).
For the headline 48 × 50 run this projects to ~40 min instead of the
prior ~2 h estimate.

The legacy single-replicate behaviour is preserved as a fallback path
(driver runs without COLA_DRIVER_REPLICATES → uses `config.seed`),
unused by the current `sweep.js` but kept for ad-hoc invocations.

**S-4. League starting state: each replicate starts from a fresh new-league.**
`bootstrapLeague` zeroes all team.cola at the start of the run. No prior
historical seasons are loaded. This is the standard "new league" starting
condition — equivalent to `initializeCola()` with no prior season data,
which is a no-op.

**S-6. Team strength persists across seasons via a Markov model tied to draft outcomes.**
See Z-2 for the transition equation and parameter values. Team strength
is initialized from Uniform[0.3, 0.7] at t=0 and updated each season as
a function of the prior season's strength, the prior season's draft
pick value, and a Normal shock. This replaces the earlier i.i.d.
Uniform[0.2, 0.6] refresh; aging curves, free agency, and trades are
still abstracted into the single strength variable. The dial space
tests the lottery mechanism, not roster-construction dynamics, but the
feedback loop (lottery position → draft pick → next-season strength)
that the primary objective measures is now wired in.

---

## 5. Objective Assumptions

**O-1. Primary objective: `maxYearsBetweenConferenceFinals`.**
Per Highley's 2026-05-26 guidance. For each franchise, compute the
longest run of consecutive seasons without making the conference finals
(`playoffRoundsWon >= 2`); take the max across franchises. Lower is
better. Computed in `objectives.js:43-90`.

**O-2. CF definition: `playoffRoundsWon >= 2`.**
Mapped to ZenGM convention: 0 = lost R1, 1 = lost R2, 2 = lost CF, 3 =
lost Finals, 4 = champion. `>=2` means appeared in CF at minimum (i.e.,
won R2 to advance to CF, or further). Per-season this yields 4
distinct franchises across the 2 conferences.

**O-3. Aggregation: max-of-max (worst franchise's worst gap).**
The primary objective is the maximum over franchises of the maximum gap.
Per Highley: this captures the *worst-served* franchise. Alternative
aggregations (median, p90) are NOT computed in the primary metric but
the per-team gaps are retained in `perTeamGaps` for diagnostic use.

**O-4. Secondary objective: `manipulationGainUpperBound` returns a unified
probability-percentage gain across capped and uncapped regimes.**
Computed from `config` directly; does not use seasonLog. The bound is
an upper bound — actual realized manipulation gain in simulation may be
lower.

The canonical field is `manipulation_gain_pct` (probability-percentage
points). The derived `manipulation_gain_bound = 1 + gain_pct/100` is
retained for backward compatibility with the pre-2026-05-26 CSV schema.

*Uncapped (Theorem 1, first-order approximation):*

    gain_pct_uncapped = 100 · 4 / |E|

For E=14 (Classic): gain_pct ≈ 28.57 %. For E=22: 18.18 %. For E=16-
tiered: 25.00 %.

*Capped (Lemma 2 ticket bound, converted to a probability via worst-
case pool):*

    gain_pct_capped = 100 · 0.3 / |E|

Derivation: Lemma 2 bounds the per-series ticket gain at `η · C` with
η = 0.3 in the play-in case (worst case across η ∈ {0.2, 0.3}). To
convert this to a probability gain, we divide by the conservative pool
upper bound `P_max = C · |E|` (all eligible teams simultaneously at
the cap). The cap value `C` cancels: gain_pct_capped ≤ 100 · 0.3 /|E|.

Caveat: the realised pool in steady state is materially smaller than
`C · |E|` (only droughted teams approach the cap), so the realised
probability gain can exceed this bound. We retain `C · |E|` here as a
*conservative analytical floor* on the manipulation gain that the
capped regime achieves, used for cross-regime Pareto comparison in
`objectives.js`. A typical-case estimate would replace `P_max` with
the empirical steady-state pool from the simulation; that estimate is
out of scope for the analytical bound. The cap-cancels-out property is
the substantive finding: under the conservative-pool assumption, only
|E| binds the capped manipulation gain.

Verification anchors (cfg_id from `dial_grid.json`):
- cfg 1 (Classic, E=14, uncapped): gain_pct = 28.57.
- cfg 17 (E=22, uncapped): gain_pct = 18.18.
- cfg 32/33 (3-2-1 baseline, E=16-tiered, uncapped): gain_pct = 25.00.
- cfg 4 (E=14, C=100): gain_pct = 2.143; per-series typical/play-in = 20/30.
- cfg 14 (E=14, C=200): gain_pct = 2.143 (identical to cfg 4: C cancels).
- cfg 37 (E=16-tiered, C=100, S=unbounded): gain_pct = 1.875.

This is a strict semantic change from the pre-2026-05-26 schema, in
which capped configs reported the raw-ticket per-series cost in the
`manipulation_gain_bound` column (e.g. cfg 37 = 20.0 raw tickets,
which is NOT a probability gain). Downstream Pareto/analysis code
that consumed `manipulation_gain_bound` will continue to work but is
now indexing an apples-to-apples probability ratio across all 48 cells.

**O-5. Secondary objective: `perSeriesCost` returns null for uncapped.**
Per Lemma 2: per-series cost = `η · C` in raw tickets (η = 0.2
standard, η = 0.3 play-in). Null when C = null (unbounded). Reported
as analytical only — not measured from simulated manipulator behavior.
Retained as a separate column (`per_series_cost_typical`,
`per_series_cost_playin`) so the raw Lemma 2 disclosure survives the
O-4 probability-conversion above.

**O-6. Secondary objective: `rankOneToFiveSpread` measures expected-pick
divergence between worst and 5th-worst team.**
Average over seasons of (5th-worst's pick − worst's pick). Small spread
= flat tanking incentive curve at the bottom. Computed from seasonLog,
filtered to lottery-eligible teams (`draftPick !== null`).

**O-7. Horizon for objective evaluation: full replicate length.**
30 seasons in smoke; 50 in headline. No truncation, no burn-in. The
first season's COLA index is 0 by construction, but Highley's primary
objective is gap-based so a zero-cola start doesn't bias it.

**O-8. No franchise relocation, contraction, or expansion.**
Franchise tids are constant across all simulated seasons. The 30 teams
defined at bootstrap remain in place. ZenGM supports relocations and
expansion drafts; we do not exercise these.

---

## 6. Comparison Baseline Assumptions

**B-1. "Status quo NBA lottery" = config_id 0 (E=14, C=null, S=single-season).**
This approximates the current NBA flattened-odds system. Other
single-season variants (E=22, etc.) sweep nearby points.

**B-2. "3-2-1 baseline" = E="16-tiered", C=null, S=single-season.**
Maps to the proposal Highley's Explorer evaluates. The exact eligibility
mask (10 non-playoff non-play-in + 4 record-9/10 + 2 7v8 losers) is
approximated in the driver as the 16 worst-record teams (see Z-1
masking). Refinement to the full 3-2-1 tier weighting is a follow-up
ticket.

**B-3. NBA historical record (1999-2025) is NOT factored into this sweep.**
The sweep is forward-simulated. The COLA Explorer
(`life/research/Collaborations/wip-papers/cola-manipulation-bound/docs/`)
handles the historical backtest; the testbed handles forward Pareto
exploration. The two evidence streams are complementary, not redundant.

**B-4. Classic COLA = config_id 1 (E=14, C=null, S=unbounded).**
Canonical reference for the paper's primary parity claim. Smoke test
verifies this config first.

---

## 7. Patch-File Architecture Assumptions

**P-1. Non-default dials are applied at runtime, not via persistent patches.**
The current driver applies E, C, S dials via runtime modifications to
the in-cache `team.cola` (eligibility mask, cap clamp, scope reset) —
no `git apply` is invoked. This is cleaner than patch-file management
for the smoke test and headline run, and equivalent in semantics:
ZenGM's `cola.updateLotteryChancesAfterPlayoffs` and `draft.genOrder`
read team.cola from cache, so mutating cache pre/post call achieves the
same outcome as patching the file.

**P-2. ρ, W, T variations would require source patches.**
Per DIAL_MAPPING.md "Dial exposure summary": ρ is encoded in file-local
constants in cola.ts, W is encoded in genOrder.ts chance logic, T in
divideChancesOverTiedTeams.ts. If a future run sweeps these dials, the
patch-file path (`patches/config_${id}.patch` applied via `git apply`)
will be needed. Current grid does not exercise this.

**P-3. Patches assume no cross-dial coupling in zengm source.**
We rely on the modularity of cola.ts (independent functions for
playoff/lottery updates) and the orthogonality of E (pool size), C
(cap), S (carry-over) at the implementation level. A patch that
modifies one would not interfere with another applied at runtime — but
this has not been stress-tested.

**P-4. The fork is pinned to a single commit.**
All assumptions hold against the cloned snapshot of `kvr06-ai/zengm`.
Upstream changes (e.g., a refactor of `PLAYOFF_FACTORS` into game
attributes) would invalidate the runtime-patch approach.

---

## 8. Driver Architecture Assumptions

**A-1. Vitest is the only viable headless harness.**
ZenGM's worker is initialized via `src/worker/index.ts`, which expects
browser globals (`self`, `window`, IDB). The project's own vitest setup
(`src/test/setup.ts`) provides all required shims (fake-indexeddb,
mocked fetch, `self`/`window` aliases). Bypassing vitest would require
duplicating this shim layer. We piggyback on it instead.

**A-2. Each replicate is one vitest subprocess.**
The driver test file reads `COLA_DRIVER_CONFIG` from env, runs the
configured seasons, writes JSON to `COLA_DRIVER_OUTPUT`, and exits. The
overhead (~2.5s startup) is acceptable for the smoke test but should be
batched for the headline run.

**A-3. The driver uses `idb.cache` directly, bypassing `idb.league`
(IndexedDB persistence).**
Mocked `idb.league` via `mockIDBLeague()` returns empty arrays for all
queries. `idb.cache` is the in-memory layer used by `helpers.ts:
resetCache()`. All ZenGM functions called by the driver operate on
cache, never persisting to fake-indexeddb. This is functionally
identical to a normal ZenGM session that runs purely in cache (the
flush path is no-op'd in `resetCache`).

**A-4. Mock flag `genOrder(true)` prevents draft-pick persistence and
prevents `updateLotteryChancesAfterLottery` from being called inside
genOrder.**
We call `updateLotteryChancesAfterLottery(top4Tids)` manually after
extracting the top-4 from the returned draftPicks. This ensures the
post-lottery diminishment is applied for COLA carry-over to the next
season's cycle.

**A-5. Driver does NOT log lottery events / notifications.**
genOrder.ts:349-355: `logLotteryChances` / `logLotteryWinners` are
skipped under `mock=true`. The driver does not depend on UI
notification side effects.

---

## 9. Limitations

**L-Z2. Strength Markov model is parametrically calibrated, not fit to
historical NBA team-strength trajectories.**
The (rho, alpha, sigma) values were tuned on the Classic-COLA smoke
config so that the per-team CF-gap distribution dispersed (max gap 22 →
28, occasional franchises with zero CF appearances over 30 years)
relative to the prior i.i.d. baseline. They were not estimated from
NBA team-strength time series, ratings-system rankings, or any other
empirical anchor. Sensitivity analysis on (rho, alpha, sigma), and a
formal calibration against either NBA SRS / Elo trajectories or
Basketball Reference SoS data, is future work.

**L-Z3. [RESOLVED 2026-05-26] Lottery-draw nondeterminism propagates into the strength trajectory.**
Original limitation: ZenGM's lottery draw used an unseeded `Math.random`,
so the draft pick assigned to each team was nondeterministic across
replicates even when the mulberry32 seed was fixed. Under the Markov
model this fed into next season's strength via the alpha * pick_value
term, so two runs with identical seeds could produce materially different
`max_years_between_conf_finals` (observed range 22-30 across 5 single-
replicate smoke runs).

Resolution: per S-3, the driver now overrides `Math.random` for the
duration of each replicate with the same mulberry32 stream used for
strength generation and bracket samples. Two consecutive runs with
identical (config_id, replicate_seed) now produce bit-identical CSVs.
The "single replicate as random draw" framing in the prior version of
this note no longer applies — single replicates are now reproducible
exactly. Headline runs still use multiple replicates to characterise
Monte Carlo dispersion over the strength-and-lottery joint distribution;
that justification is unchanged.

---

## Cross-References

- Paper: `paper/sections/03-cola-family.tex` §3.1.2 Definition 2 (seven
  dials).
- Dial map: `DIAL_MAPPING.md`.
- Engine: `zengm-fork/src/worker/core/draft/cola.ts`,
  `zengm-fork/src/worker/core/draft/genOrder.ts`.
- Driver: `zengm-fork/src/worker/core/draft/colaSweepDriver.test.ts`.
- Sweep harness: `sweep.js`.
- Objectives: `objectives.js`.
- Highley Substack reference: <https://zengm.com/blog/2026/02/cola-draft-type/>
