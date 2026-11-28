# The simulations and the analysis scripts

This folder holds everything behind the paper's numbers: the driver that runs
the ten draft mechanisms inside the simulator, the result files of those runs,
the NBA seasons used for comparison, and one script for each section of the
paper that reports numbers.

## What is here

    measures.js                    the paper's measures, shared by the scripts below
    pick_dist.js                   exact pick chances for a lottery that draws its first picks
    abstract_table.js              the abstract's table
    swap_check.js                  Section 4.2
    limits_check.js                Section 5
    design_check.js                Section 6
    results_check.js               Sections 7 and 8.1
    draft2026_check.js             Section 8.2, the 2026 draft under each mechanism
    make_figures.py                Figures 1 to 8, from the three scripts above (needs Python 3
                                   and matplotlib; set in Caladea when it is installed)
    simple_losing_check.js         checks the Simple COLA run against its rule
    verify_classic.js              checks the Classic COLA run against its rules
    t321_adopted_check.js          checks the 3-2-1 run against its rules
    verify_capped.js               checks the Capped COLA run against its rules
    colaFullEngineDriver.test.ts   the driver, which runs one mechanism inside the simulator
    deploy.sh                      copies the driver into the simulator's source tree
    frontier_run.sh                launches the ten-mechanism run
    frontier_watchdog.sh           keeps a long run within memory and disk (macOS)
    rerun_guarded.sh               runs frontier_run.sh under a memory guard (macOS)
    data/nba-data.json             NBA standings, playoff results and first-round picks,
                                   1999-00 to 2025-26
    runs/frontier/                 result files of the ten-mechanism run
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
| `capped.json` | Capped COLA |
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
| `colaPre` | Lottery tickets before the drawing, used by the ticket mechanisms; in `capped.json`, the stockpile the drawing used |
| `cola` | Lottery tickets after the draft; in `capped.json`, the stockpile after the draft |
| `rosterOvr` | Average rating of the team's eight best players |
| `seed` | In `capped.json` only: the team's seed in its conference's first round of the playoffs, or null |
| `pickHolder` | In `capped.json` only: the team that held its own first-round pick on lottery day |

`analysis.txt`, `analysis_recut.txt` and `counterfactual.txt` in the same
folder are printed outputs of earlier analyses of these runs.

## The NBA data

`data/nba-data.json` holds the NBA's regular seasons and playoffs from 1999-00
to 2025-26, compiled from Basketball Reference. Its `seasons` list gives each
season's label (`season`, as `1999-00`), the year it ended (`year`) and its
`teams`, with these fields for each team.

| Field | Meaning |
|:--|:--|
| `id`, `name` | Team abbreviation, and the team's name that season |
| `wins`, `losses` | Regular-season record |
| `madePlayoffs` | Whether the team reached the playoffs, directly or through the play-in |
| `playoffResult` | The round the team lost in, `first_round`, `second_round`, `conf_finals` or `finals`, or `champion`; null for a team that missed the playoffs |
| `seriesWon` | Playoff series won, 0 to 4 |
| `draftPick` | The team's best first-round pick in the draft after the season, by the team that made it; null if it made none |
| `playInParticipant` | Whether the team played in the play-in, held from 2019-20 on |
| `playInAdvanced` | Whether the team reached the playoffs through the play-in |
| `playoffSeed` | In 2025-26 only: the team's playoff seed in its conference, 1 to 8, or null |

The 2025-26 season is recorded as it stood after the first round of the 2026
playoffs, before the draft lottery. A team still playing after that round shows
one series won and a null `playoffResult`, and no team has a `draftPick`. For
picks 15 to 30, `draftPick` follows Basketball Reference's draft pages, which
list the original holder of a pick traded on draft night. The file also gives
each franchise's current name under `teams`, and its moves and renames since
1999-00 under `relocations`.

## How the mechanisms are run

Section 3 of the paper defines the ten mechanisms, and the driver is the exact
record of how each was run. Four of its choices are worth knowing.

- Under 3-2-1, the team with the eighth-best record in each conference stands
  in for the loser of the seven-eight play-in game.
- Under Beckett COLA, a top-six finish in a conference is read from
  regular-season wins.
- A mechanism sets where each team's own first-round pick falls. A traded pick
  keeps that place, and the team that holds it makes the selection.
- Under Capped COLA, the seeds come from the simulator's playoff bracket. No
  team declines a pick. A team at the cap must hold its own first-round pick
  every other year, which the simulator cannot enforce, so a top-five pick's
  cost falls on the team whose own pick it was.

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
   Node.js 24 and pnpm 11.
3. Run `./deploy.sh` to copy the driver into the simulator's source tree.
4. Run `./frontier_run.sh`. It writes each mechanism's leagues to
   `runs/frontier/` in chunks of six and skips any chunk already there.
   `./rerun_guarded.sh` does the same and stops the run if its processes pass
   16 GB of memory in total. It uses macOS commands, so on Linux run
   `./frontier_run.sh` directly.

One number, the seed, fixes every chance event in a league, so a given seed and
mechanism reproduce a league. On our machine, six leagues of 25 seasons took
about 37 minutes in one process. That makes about 75 minutes for one mechanism
at three processes and about 12 hours for the whole run.

The run uses three processes at a time by default, because our machine also
runs other work that needs a lot of CPU and memory. A machine with more cores
and memory can run more at once and finish sooner. The fourth argument of
`./frontier_run.sh` sets the number, so `./frontier_run.sh 25 30 6 5` runs five
at a time, and `./rerun_guarded.sh` takes it as its first argument. Our three
processes peaked at 11.8 GB together, so with `./rerun_guarded.sh`, raise its
memory ceiling, the second argument (16 GB by default), by about 4 GB for each
process added.

If a script will not start because it is not executable, run `chmod +x *.sh`
first, or start it with `sh`, as in `sh ./frontier_run.sh`.
