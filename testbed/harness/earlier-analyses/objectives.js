#!/usr/bin/env node
/**
 * Objective functions for the Basketball-GM COLA sweep.
 *
 * Four objectives are computed per (config, season-log) pair. The primary
 * objective is per Highley's guidance: minimise the max years between any
 * franchise's conference-finals appearances. Secondary objectives provide
 * analytical and per-series-cost views from the manipulation-bound paper.
 *
 * The simulation produces a `seasonLog` array where each entry records:
 *   {
 *     season: number,
 *     teams: [
 *       { tid: number, conf: 'E'|'W', wins: number,
 *         playoffRoundsWon: number,        // -1 = lottery, 0 = R1 loss, 1 = R2 loss, 2 = CF loss, 3 = finals loss, 4 = champion
 *         draftPick: number|null,          // 1..N if received a pick, null if not in lottery
 *         cola: number                     // post-update lottery index
 *       },
 *       ...
 *     ]
 *   }
 *
 * Conference-finals appearance: playoffRoundsWon >= 2 (made the CF round at
 * minimum). Two conferences each season, so two CF participants per season per
 * conference (loser + champion of each conference's semifinal bracket). For a
 * 30-team league this is 4 distinct franchises per season making the CF.
 */

// =============================================================================
// Primary objective: max years between conference-finals appearances.
// Per Highley's May 26 guidance: "we could use Basketball-GM to optimize for
// minimize max years between conference finals appearances."
// =============================================================================

/**
 * For each franchise, compute the longest consecutive run of seasons in which
 * that franchise did NOT make the conference finals. Return the max over all
 * franchises. Lower is better (more equitable parity).
 *
 * @param {Array} seasonLog - chronologically ordered season entries
 * @returns {{ maxGap: number, perTeamGaps: Object<tid, number>, neverReached: number[] }}
 */
function maxYearsBetweenConferenceFinals(seasonLog) {
    if (!Array.isArray(seasonLog) || seasonLog.length === 0) {
        throw new Error("maxYearsBetweenConferenceFinals: seasonLog must be a non-empty array");
    }

    // Build per-team appearance histories. CF appearance = playoffRoundsWon >= 2.
    const tids = new Set();
    for (const entry of seasonLog) {
        for (const t of entry.teams) tids.add(t.tid);
    }

    const appearanceSeasons = {};  // tid -> sorted list of season indices where team reached CF
    for (const tid of tids) appearanceSeasons[tid] = [];

    seasonLog.forEach((entry, seasonIdx) => {
        for (const t of entry.teams) {
            if (t.playoffRoundsWon >= 2) {
                appearanceSeasons[t.tid].push(seasonIdx);
            }
        }
    });

    const totalSeasons = seasonLog.length;
    const perTeamGaps = {};
    const neverReached = [];
    let maxGap = 0;

    for (const tid of tids) {
        const apps = appearanceSeasons[tid];
        if (apps.length === 0) {
            // Never reached CF: gap = total simulation length (worst-case)
            perTeamGaps[tid] = totalSeasons;
            neverReached.push(tid);
            maxGap = Math.max(maxGap, totalSeasons);
            continue;
        }
        // Gap-before-first-appearance, between-appearance gaps, gap-after-last-appearance.
        let teamMaxGap = apps[0];                                      // gap before first
        for (let i = 1; i < apps.length; i++) {
            teamMaxGap = Math.max(teamMaxGap, apps[i] - apps[i - 1] - 1);
        }
        teamMaxGap = Math.max(teamMaxGap, totalSeasons - 1 - apps[apps.length - 1]);
        perTeamGaps[tid] = teamMaxGap;
        maxGap = Math.max(maxGap, teamMaxGap);
    }

    return { maxGap, perTeamGaps, neverReached };
}

// =============================================================================
// Secondary objective: analytical manipulation-gain upper bound, unified across
// capped and uncapped regimes as a probability-percentage-point gain (Δp · 100).
//
// Both regimes return `gain_pct`, the bounded probability gain (in percentage
// points) from a single optimal manipulation. The derived multiplicative bound
// `bound = 1 + gain_pct / 100` is retained for backward compatibility with the
// pre-2026-05-26 schema (where `manipulation_gain_bound` carried a mix of
// multiplicative ratios for uncapped configs and raw-ticket counts for capped
// configs — an unit mismatch). The unification rests on the following:
//
//   Uncapped (Classic-style, per Theorem 1 / Eq. 6 with the first-order
//   approximation G_i ≈ p_i · (Δ/P)):
//     gain_pct_uncapped ≈ 100 · 4 / |E|
//   This matches the existing 1 + 4/|E| multiplicative bound numerically:
//     bound_uncapped = 1 + 4/|E|  ⇒  gain_pct = 100 · (bound - 1) = 100 · 4/|E|.
//   For Classic (E=14): gain_pct ≈ 28.57 %.
//
//   Capped (per Lemma 2 worst-case, converted to a probability):
//     Per Lemma 2 a team at the cap gains at most 0.3·C tickets per series
//     (play-in case; 0.2·C otherwise). We adopt the worst case η = 0.3.
//     The conservative upper bound on the pool is C · |E| (all eligible teams
//     simultaneously at the cap), yielding:
//
//         Δp_capped ≤ 0.3·C / (C·|E|) = 0.3 / |E|
//         gain_pct_capped ≤ 100 · 0.3 / |E|
//
//     The cap value C cancels out: only the eligibility size |E| binds.
//   For E=14: gain_pct ≤ 2.143 %. For E=22: gain_pct ≤ 1.364 %. For 16-tiered:
//   gain_pct ≤ 1.875 %.
//
// Caveat: the capped bound is a stronger claim than Lemma 2 itself. Lemma 2
// bounds ticket gain; converting to a probability bound here requires the
// worst-case pool assumption P_max = C·|E|. In realistic regimes only the
// already-droughted teams accumulate to the cap, so the realised pool is
// smaller and the realised gain larger than the bound. We retain the
// conservative C·|E| pool ceiling so the bound is genuinely an upper bound,
// not a typical-case estimate. See ASSUMPTIONS.md item O-4 for the audit
// trail of this derivation.
// =============================================================================

/**
 * Compute the theoretical manipulation-gain upper bound for a given dial
 * configuration. Closed-form, no simulation dependency. Returns the
 * probability gain in percentage points (`gain_pct`) as the canonical value,
 * plus the derived multiplicative bound `1 + gain_pct/100`.
 *
 * @param {Object} config - dial configuration with fields { E, delta, C, S, ... }
 * @returns {{ gain_pct: number, bound: number, regime: 'capped'|'uncapped', formula: string, notes: string }}
 */
function manipulationGainUpperBound(config) {
    const { E, C } = config;

    // Off-grid named anchors (Countdown, Beckett) are NOT cola mechanisms, so the
    // cola manipulation-gain bound (a closed form in |E|) is undefined for them.
    // Return N/A rather than a misleading nominal value, so the anchors are not
    // credited or penalized on the manipulation axis of the Pareto frontier.
    if (config.variant) {
        return {
            gain_pct: null,
            bound: null,
            regime: "n/a",
            formula: "n/a (non-cola named anchor)",
            notes: `Manipulation-gain bound is undefined for the '${config.variant}' mechanism; not a cola variant.`,
        };
    }

    const eligibilitySize = typeof E === "number" ? E : (E === "16-tiered" ? 16 : 22);

    if (C !== null && C !== undefined) {
        // Capped regime. Worst-case ticket gain per series (Lemma 2, play-in
        // case): eta * C with eta = 0.3. Worst-case pool: C * |E|.
        // ⇒ gain_pct ≤ 100 * 0.3 / |E| (cap C cancels).
        const etaPlayIn = 0.3;
        const gain_pct = 100 * etaPlayIn / eligibilitySize;
        const bound = 1 + gain_pct / 100;
        return {
            gain_pct,
            bound,
            regime: "capped",
            formula: `100 * ${etaPlayIn} / |E| = 100 * ${etaPlayIn} / ${eligibilitySize} = ${gain_pct.toFixed(4)} %`,
            notes: "Capped configuration: Lemma 2 ticket bound (eta * C) converted to probability via worst-case pool C * |E|; cap C cancels.",
        };
    }

    // Uncapped (Classic-style) bound. gain_pct = 100 * 4 / |E|.
    const gain_pct = 100 * 4 / eligibilitySize;
    const bound = 1 + gain_pct / 100;
    return {
        gain_pct,
        bound,
        regime: "uncapped",
        formula: `100 * 4 / |E| = 100 * 4 / ${eligibilitySize} = ${gain_pct.toFixed(4)} %`,
        notes: `Classic-style uncapped bound (Theorem 1 first-order approximation). |E| = ${eligibilitySize}.`,
    };
}

// =============================================================================
// Secondary objective: per-series cost (capped variants only).
// Lemma 2 of the manipulation-bound paper: the manipulator's per-playoff-series
// cost is bounded by eta * C, where eta = 0.2 (typical round) or 0.3 (play-in).
// =============================================================================

/**
 * Compute the per-series cost ceiling for a capped configuration. Returns
 * null if the config is uncapped (in which case per-series cost is unbounded).
 *
 * @param {Object} config - dial configuration with field C
 * @returns {{ typical: number, playIn: number } | null}
 */
function perSeriesCost(config) {
    const { C } = config;
    if (C === null || C === undefined) return null;
    return {
        typical: 0.2 * C,
        playIn: 0.3 * C,
        cap: C,
        formula: `0.2 * ${C} typical; 0.3 * ${C} play-in (Lemma 2)`
    };
}

// =============================================================================
// Secondary objective: rank-1-to-5 spread (anti-tanking strength proxy).
// Expected pick position of the worst 5 teams over the simulation. A small
// spread between the worst team and the 5th-worst team's expected pick means
// tanking yields little marginal advantage.
// =============================================================================

/**
 * Compute the expected pick position for each of the worst-5 final-record
 * teams in each season, averaged across the simulation. The "spread" metric
 * is the difference between the 5th-worst team's expected pick and the worst
 * team's expected pick. A spread near zero implies tanking-resistant.
 *
 * @param {Array} seasonLog
 * @returns {{ expectedPickByWorstRank: number[], spread1To5: number }}
 */
function rankOneToFiveSpread(seasonLog) {
    const N_WORST = 5;
    const expectedSums = new Array(N_WORST).fill(0);
    let nSeasons = 0;

    for (const entry of seasonLog) {
        // Rank lottery-eligible teams by wins ASC (worst first).
        const lottery = entry.teams
            .filter(t => t.draftPick !== null && t.draftPick !== undefined)
            .slice()
            .sort((a, b) => a.wins - b.wins);

        if (lottery.length < N_WORST) continue;
        for (let i = 0; i < N_WORST; i++) {
            expectedSums[i] += lottery[i].draftPick;
        }
        nSeasons += 1;
    }

    if (nSeasons === 0) {
        return { expectedPickByWorstRank: [], spread1To5: NaN, nSeasons: 0 };
    }

    const expectedPickByWorstRank = expectedSums.map(s => s / nSeasons);
    const spread1To5 = expectedPickByWorstRank[N_WORST - 1] - expectedPickByWorstRank[0];

    return { expectedPickByWorstRank, spread1To5, nSeasons };
}

// =============================================================================
// Manipulation reconciliation (2026-06-17): manipulation is now MEASURED by
// simulation in `manip_analysis.js` as the realized pool-swap gain, not derived
// from the closed form below. For gamma=1 (proportional weighting) the realized
// gain is at most 2.14% in the 14-team-pool framing and at most 1.19% in the
// engine's 22-team pool, which empirically confirms Theorem 1's about-4%
// analytic bound. `manipulationGainUpperBound()` (the closed form) is retained
// for analytic reference only and is already out of the scoring pipeline
// (dropped from `evaluateAll` below). This reconciles the metric with Theorem 1:
// the closed form's uncapped value (about 29% for Classic) had contradicted the
// bound, which is why the simulated measure supersedes it.
// =============================================================================

// =============================================================================
// Aggregator: run all four objectives, return a flat record for CSV output.
// =============================================================================

function evaluateAll(config, seasonLog) {
    const primary = maxYearsBetweenConferenceFinals(seasonLog);
    const rankSpread = rankOneToFiveSpread(seasonLog);

    // NOTE (2026-06-16 rebuild): the analytic manipulation-gain objective
    // (`manipulation_gain_pct`, a closed form in |E|) is intentionally NOT
    // emitted here. Its uncapped Classic value (~29%) contradicts the ~4%
    // Theorem-1 bound, and it never read the simulation. Manipulation is now
    // MEASURED by simulating a manipulator against the multi-year pool (a
    // separate driver; see the rebuild plan). manipulationGainUpperBound() and
    // perSeriesCost() are kept below for analytic reference only, out of the
    // pipeline.
    return {
        max_years_between_conf_finals: primary.maxGap,
        franchises_never_reached_cf: primary.neverReached.length,
        rank_one_to_five_spread: rankSpread.spread1To5,
        expected_pick_worst: rankSpread.expectedPickByWorstRank[0],
        expected_pick_fifth_worst: rankSpread.expectedPickByWorstRank[4],
    };
}

module.exports = {
    maxYearsBetweenConferenceFinals,
    manipulationGainUpperBound,
    perSeriesCost,
    rankOneToFiveSpread,
    evaluateAll,
};

// Self-test when invoked directly.
if (require.main === module) {
    // Synthetic season log: 10 seasons, 4 teams, manufactured CF appearances.
    const synthetic = [];
    for (let s = 0; s < 10; s++) {
        synthetic.push({
            season: s,
            teams: [
                { tid: 0, conf: 'E', wins: 60, playoffRoundsWon: s % 3 === 0 ? 3 : -1, draftPick: s % 3 === 0 ? null : 1, cola: 0 },
                { tid: 1, conf: 'E', wins: 50, playoffRoundsWon: s % 3 === 1 ? 2 : 0, draftPick: 2, cola: 1000 },
                { tid: 2, conf: 'W', wins: 45, playoffRoundsWon: 2, draftPick: 3, cola: 500 },
                { tid: 3, conf: 'W', wins: 20, playoffRoundsWon: -1, draftPick: 4, cola: 2000 },
            ],
        });
    }
    const config = { E: 14, delta: 1000, C: null, S: "unbounded" };
    console.log("objectives.js self-test");
    console.log(JSON.stringify(evaluateAll(config, synthetic), null, 2));
}
