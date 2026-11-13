# Earlier analyses

These scripts and notes come from an earlier draft of the paper, which scored
the mechanisms in other ways and mostly on other runs (48 leagues of 15
seasons). They are kept for reference. The paper's numbers come from the
scripts one level up.

Run them from `testbed/harness`, one level up, so that their default paths
resolve:

    node earlier-analyses/frontier_analysis.js

## Analyses of the nine-mechanism run

| File | What it does |
|:--|:--|
| `frontier_analysis.js` | An earlier four-criteria comparison. `runs/frontier/analysis.txt` and `analysis_recut.txt` are its printed output |
| `sim_vs_real.js` | An earlier comparison with the NBA, replaced by `design_check.js` |
| `metric_screen.js` | A screen of candidate priority measures, on `runs/ref/nba.json` |

## Analyses of the earlier runs

Their inputs are not in the repository. The runners below write them under
`runs/`.

| File | What it does |
|:--|:--|
| `paper_tables.js` | The earlier draft's tables: two rankings and help gradients |
| `gap_decomposition.js` | Where the old lottery's reward for losing comes from |
| `tank_counterfactual.js` | Picks bought by losing, one team's record moved at a time. `runs/frontier/counterfactual.txt` is its printed output on the nine-mechanism run |
| `tank_crosscheck.js` | A sampled check of the script above |
| `tank_engine.js` | A run in which one team sits its best players |
| `pool_swap.js`, `manip_analysis.js` | What a team gains by changing which teams are in the pool |
| `help_gradient.js`, `own_metric_gaps.js`, `stats_tests.js` | Help by each mechanism's own ranking, with tests |
| `e14_analysis.js`, `wsweep_analysis.js` | Runs with a 14-team pool, and with other lottery weights |
| `channel_probe.js` | What a draft pick is worth, from runs with a random draft order |
| `objectives.js` | Code shared by several of the scripts above |

## Runners and tests

| File | What it does |
|:--|:--|
| `e14_run.sh`, `ref_run.sh`, `tank_run.sh`, `tighten_run.sh`, `wsweep_run.sh`, `probe_run.sh` | Launch the earlier runs with the driver one level up |
| `sweep.js`, `run_sweep.sh`, `dial_grid.json` | The first, grid-based sweep, retired |
| `colaFullEngineSpike.test.ts`, `colaSimBenchmark.test.ts` | Two early tests of the simulator. Copy them into the simulator's `src/test/` to run them |

## Notes

`TESTBED_NOTES.md` was this folder's README until November 2026.
`ASSUMPTIONS.md`, `ASSUMPTIONS_FOR_HIGHLEY.md` and `DIAL_MAPPING.md` record the
modeling choices of the earlier work, and items FE-1 to FE-7 of
`ASSUMPTIONS.md` cover the nine-mechanism run. File paths inside these notes
are relative to `testbed/harness`.
