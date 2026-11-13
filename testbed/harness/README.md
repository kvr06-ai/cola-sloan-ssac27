# The simulations and the analysis scripts

This folder holds everything behind the paper's numbers: the driver that runs
the nine draft mechanisms inside the simulator, the result files of those runs,
the NBA seasons used for comparison, and one script for each section of the
paper that reports numbers.

## What is here

    measures.js                    the paper's measures, shared by the scripts below
    pick_dist.js                   exact pick chances for a lottery that draws its first picks
    abstract_table.js              the abstract's table
    simple_losing_check.js         Section 4 and, with --cutoff, Section 5.2
    limits_check.js                Section 5
    design_check.js                Section 6
    results_check.js               Section 7
    verify_classic.js              checks the Classic COLA run against its rules
    t321_adopted_check.js          checks the 3-2-1 run against its rules
    colaFullEngineDriver.test.ts   the driver, which runs one mechanism inside the simulator
    deploy.sh                      copies the driver into the simulator's source tree
    frontier_run.sh                launches the nine-mechanism run
    frontier_watchdog.sh           keeps a long run within memory and disk
    rerun_guarded.sh               runs frontier_run.sh under a memory guard
    data/nba-data.json             NBA standings, playoff results and first-round picks,
                                   1999-00 to 2025-26
    runs/frontier/                 result files of the nine-mechanism run
    runs/ref/nba.json              one run of an earlier design, read by
                                   earlier-analyses/metric_screen.js
    earlier-analyses/              scripts and notes from an earlier draft

Run every script from this folder. The README at the top of the repository
lists the command behind each section of the paper.

## The result files

Each file in `runs/frontier/` holds one mechanism's 30 leagues of 25 seasons.

| File | Mechanism in the paper |
|:--|:--|
| `nba.json` | Old lottery, the NBA's from 2019 to 2026 |
| `uniform.json` | Equal-odds lottery |
| `t321.json` | 3-2-1 as adopted |
| `classic.json` | Classic COLA |
| `waitlist.json` | Waitlist COLA |
| `full.json` | Full-lottery COLA |
| `simplerule.json` | Simple COLA |
| `countdown.json` | Countdown COLA |
| `beckett.json` | Beckett COLA |
| `simple.json` | An earlier, ticket-based form of Simple COLA, not in the paper |

A file is a list of 30 leagues. Each league has a `seed`, 0 to 29 and shared by
all mechanisms, and a `seasonLog` of 25 seasons. Each season lists the 30 teams
with these fields.

| Field | Meaning |
|:--|:--|
| `tid` | Team number, the same in every season of a league |
| `conf` | Conference, `E` or `W` |
| `wins` | Regular-season wins out of 82 |
| `playoffRoundsWon` | -1 missed the playoffs, 0 lost in the first round, 1 to 3 series won, 4 champion |
| `draftPick` | Where the team's own first-round pick fell, 1 to 30 |
| `colaPre` | Lottery tickets before the drawing, used by the three ticket mechanisms |
| `cola` | Lottery tickets after the draft |
| `rosterOvr` | Average rating of the team's eight best players |

`analysis.txt`, `analysis_recut.txt` and `counterfactual.txt` in the same
folder are printed outputs of earlier analyses of these runs.

## How the mechanisms are run

Section 3 of the paper defines the nine mechanisms, and the driver is the exact
record of how each was run. Three of its choices are worth knowing.

- Under 3-2-1, the team with the eighth-best record in each conference stands
  in for the loser of the seven-eight play-in game.
- Under Beckett COLA, a top-six finish in a conference is read from
  regular-season wins.
- A mechanism sets where each team's own first-round pick falls. A traded pick
  keeps that place, and the team that holds it makes the selection.

Longer notes on these and earlier modeling choices are in
`earlier-analyses/ASSUMPTIONS.md`, items FE-1 to FE-7.

## Running the simulations again

The analysis scripts need only Node.js. Running the simulations again also
needs the simulator, ZenGM Basketball-GM, which is not part of this repository
and has its own license.

1. Clone the simulator into this folder as `zengm-fork`. We ran commit
   `e36eb54` of 25 May 2026, the tip of `master` at
   <https://github.com/kvr06-ai/zengm>, a fork of
   <https://github.com/zengm-games/zengm>.
2. Install its packages as its README describes (`pnpm install`). It asks for
   Node.js 24.
3. Run `./deploy.sh` to copy the driver into the simulator's source tree.
4. Run `./frontier_run.sh`. It writes each mechanism's leagues to
   `runs/frontier/` in chunks of six and skips any chunk already there.
   `./rerun_guarded.sh` does the same and stops the run if its processes pass
   16 GB of memory in total.

One number, the seed, fixes every chance event in a league, so a given seed and
mechanism reproduce a league. On our machine, six leagues of 25 seasons took
about 37 minutes in one process. That makes about 75 minutes for one mechanism
at three processes and about 11 hours for all nine.

A fresh clone loses the executable bit on the shell scripts when it comes
through Overleaf, so run `chmod +x *.sh` first if a script will not start.
