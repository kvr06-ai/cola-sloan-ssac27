# Simulator — the public two-test results page

`index.html` is the canonical source of the interactive results page ("COLA
weighting testbed: two tests in the full engine"): the E=22 and E=14 results
tables, the verdict block, and the Monte Carlo lottery playground (14 drought
sliders, mechanism selector, 20,000 draws per change). One self-contained file,
no external dependencies.

## Where it is served

GitHub Pages cannot serve this repo's path (project-pages URLs are bound to the
repo name, and this repo is private), so the page deploys to the public
`cola-manipulation-bound` repo, which Pages serves from `main:/docs`:

    https://kvr06-ai.github.io/cola-manipulation-bound/sweep/

## Update procedure

1. Edit `index.html` here (this copy is canonical).
2. `./deploy.sh` (copies it to `../../cola-manipulation-bound/docs/sweep/`).
3. Commit + push BOTH repos (this one for the source of record, the public one
   to go live).

## Data provenance

Every number on the page is baked in from the full-engine runs in
`../testbed/harness` (n=48 leagues x 15 seasons per mechanism):

- E=22 two-test table: `own_metric_gaps.js` + `stats_tests.js` on `runs/tighten`
- E=14 table + middle option: `e14_analysis.js` on `runs/e14`
- manipulation: `manip_analysis.js`

Do not edit numbers by hand; rerun the scripts and transcribe. Cells the runs
do not cover stay "not measured".
