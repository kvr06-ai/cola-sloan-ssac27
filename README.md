# Practical Incentive-Compatible Drafts: Carry-Over Lottery Allocation

Paper, simulation code and data for our submission to the MIT Sloan Sports
Analytics Conference 2027 (SSAC27), in the Basketball track.

Carry-Over Lottery Allocation (COLA) measures a team's weakness by its playoff
results over many seasons. Each team carries a draft priority from one season
to the next. Priority grows while the team goes without playoff success and
falls when it wins a playoff series or receives a high pick, so losing more
games this season adds nothing. The paper presents COLA as a family of draft
mechanisms, proves that a member of the family is incentive compatible under
stated assumptions, and compares nine mechanisms inside a full basketball
simulator on help for long-waiting teams, long-term parity, and the reward for
losing.

This is a working draft. The paper in `paper/` is still being written, and the
interactive results page shows the simulations of an earlier draft.

## Repository layout

    paper/                  the paper: main.tex, references.bib and the built
                            main.pdf, with the outline it follows
    abstract-submission/    the abstract as submitted to SSAC27 and accepted,
                            its source, and the script that counts its words
    testbed/harness/        the simulation driver, the analysis scripts, the
                            result files of the simulations and the NBA data
    results-page/           source of the public interactive results page
    original-study/         code and data of an earlier COLA preprint
                            (arXiv:2602.02487), by its authors
    LICENSE                 the MIT License, for the code and result files

## Reproducing the paper's numbers

You need Node.js 18 or later and nothing else. Each command below reads only
files in this repository, finishes in under a minute, and prints the same
output every time.

    cd testbed/harness

| Command | What it reproduces |
|:--|:--|
| `node abstract_table.js --table1` | The table in the abstract, and the summary figures in Section 1 |
| `node simple_losing_check.js` | Section 4: the test of Theorem 1 on the simulated leagues, and what one more loss costs a team |
| `node simple_losing_check.js --cutoff` | Section 5.2: the line between the third and fourth picks |
| `node limits_check.js` | Section 5: Table 2, and the seasons after a top-three pick |
| `node design_check.js` | Section 6: the design of the simulations, and Tables 3 and 4 |
| `node verify_classic.js runs/frontier/classic.json` | A check of the Classic COLA simulations against the mechanism's rules |
| `node t321_adopted_check.js runs/frontier/t321.json` | The same check for 3-2-1 |

## The simulations and the data

The simulated leagues come from ZenGM Basketball-GM, a basketball simulator
with public code. Our driver sets the first-round draft order under each
mechanism, and the simulator plays out everything else: every game, and every
trade, signing and draft selection, with its own general managers running all
30 teams. One seed fixes every chance event in a league, so a given seed and
mechanism reproduce a league.

`testbed/harness/runs/frontier/` holds one result file for each mechanism, with
30 leagues of 25 seasons in each. Every mechanism starts from the same 30
leagues. `testbed/harness/data/nba-data.json` holds the NBA's standings,
playoff results and first-round picks from 1999-00 to 2025-26, compiled from
Basketball Reference.

`testbed/harness/README.md` describes both file formats and how to run the
simulations again, which needs the simulator and takes about 11 hours.

## Building the paper

    tectonic paper/main.tex
    tectonic abstract-submission/ssac27-abstract.tex

## License

The code and result files in this repository are released under the MIT
License (see `LICENSE`). Three things sit outside it:

- `paper/` and `abstract-submission/` hold the manuscript and the abstract,
  which remain the authors' and are not licensed for reuse.
- `original-study/` holds the code and data of the earlier study, by its own
  authors. It is included for reference and keeps its original terms.
- The simulator, ZenGM Basketball-GM, is not part of this repository. It is
  available from its developer under its own license, which is not an
  open-source license.

The NBA standings, playoff results and draft picks in
`testbed/harness/data/nba-data.json` are facts compiled from Basketball
Reference, shared here so the results can be reproduced.

## Related

The code and data behind an earlier preprint on COLA, Highley, Duncan, and
Volkov (2026), "Carry-Over Lottery Allocation: Practical Incentive-Compatible
Drafts" (<https://arxiv.org/abs/2602.02487>), are in `original-study/`,
merged with their full commit history from
<https://github.com/vilka-9999/carry_over_lotter_allocation_research>.

The published interactive backtester covering 26 NBA seasons lives at
<https://kvr06-ai.github.io/cola-manipulation-bound/>, with a results and
scenario playground at <https://kvr06-ai.github.io/cola-manipulation-bound/sweep/>.
