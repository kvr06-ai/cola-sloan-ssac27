# Practical Incentive-Compatible Drafts: Carry-Over Lottery Allocation

This repository holds the code and data for our submission to the MIT Sloan
Sports Analytics Conference 2027 (SSAC27), in the Basketball track. The paper
proposes Carry-Over Lottery Allocation (COLA), a new way to set the order of the
National Basketball Association (NBA) draft. The paper is not in this
repository.

## The problem

Each year, NBA teams take turns choosing new players in the draft. Each turn is
called a pick, and an earlier pick gives a team a better choice. To help weak
teams improve, the draft gives earlier picks to teams with worse records.

That rule gives a weak team a reason to lose games on purpose, so that it
finishes lower and picks earlier. Losing on purpose is called tanking. The NBA
uses a lottery, a random drawing, to decide which of the teams that missed the
playoffs get the earliest picks. Under the lottery it used from 2019 to 2026, a
worse record brought better odds, so losing still paid.

At the same conference in 2020,
[Banchio and Munro](https://www.sloansportsconference.com/research-papers/a-no-tanking-draft-allocation-policy)
studied lotteries that set their odds by the final standings, the ranking of
teams by record at the end of one season. They proved that any such lottery
gives some team a reason to lose, unless every team that missed the playoffs
gets the same odds. A lottery of this kind therefore cannot both help the
weakest teams and remove the reason to lose.

## The idea

COLA measures a team's weakness by its playoff results over many seasons. Each
team holds a score called its draft priority. The score carries over from one
season to the next, which gives COLA its name. A playoff series is one round of
the playoffs, played between two teams. Priority grows in each season a team
goes without a series win, and it falls when the team wins a series or receives
a top pick. Regular-season losses do not enter a team's priority, so a draft
ordered by priority need not reward losing.

COLA is a family of rules for setting the draft order, and the paper calls each
rule a mechanism. The mechanisms differ in how priority grows, how it falls,
and how it turns into picks.

The paper focuses on the simplest mechanism, Simple COLA, which holds no
drawing. Under Simple COLA, a team's priority is its wait, the number of
seasons since it last won a playoff series or received one of the first three
picks. The teams without a series win this season pick first, longest wait
first. Between two teams with the same wait, the one with more wins this season
picks first.

A mechanism is called incentive compatible when no team can get an earlier pick
by losing on purpose. The paper proves that Simple COLA is incentive compatible
under assumptions it states about how teams behave.

## What the paper does

The paper compares ten mechanisms in a basketball simulator, on the same 30
simulated leagues of 25 seasons each. Three of them are lotteries that look at
one season only. They are the NBA's lottery from 2019 to 2026, its new lottery
called 3-2-1, and a lottery with equal odds for every team that missed the
playoffs. The NBA adopted 3-2-1 in May 2026, and it starts with the 2027 draft.
It gives each of 16 teams one, two, or three chances in the drawing. The other
seven mechanisms are COLA mechanisms, Simple COLA among them.

The paper measures three things:

- help for the teams that have waited longest;
- long-term parity, meaning how evenly playoff success spreads across teams
  over many seasons;
- the reward for losing, meaning how many draft places a team would gain by
  finishing with a worse record.

In the simulations, Simple COLA gave no reward for losing from any position in
the standings. The longest stretch any team went without a series win or a
top-three pick averaged 16.3 seasons under 3-2-1 and 5.5 under Simple COLA. The
average wait for a team's next series win was within about a tenth of a season
of the wait under 3-2-1. Sections 5 and 7 of the paper measure what Simple COLA
costs.

## What is in this repository

    testbed/harness/       the code that runs each mechanism in the simulator,
                           the simulation results, the NBA data, and the
                           scripts behind every number we computed
    results-page/          the source of an interactive results page from an
                           earlier draft (see Earlier work)
    original-study/        the code and data of an earlier paper on COLA (see
                           Earlier work)
    LICENSE                the MIT License

## Reproducing the paper's numbers

Every number we computed for the paper, and every table and figure, comes from
a script in `testbed/harness/`. The scripts read only files in this repository,
so you can check every number without the simulator. Each script finishes in
under a minute and prints the same output every time.

You need Node.js 18 or later. Drawing the figures also needs Python 3 with
matplotlib, a plotting library (`pip install matplotlib`). Run each command
below from `testbed/harness/`.

    cd testbed/harness

| Command | What it prints | In the paper |
|:--|:--|:--|
| `node abstract_table.js --table1` | The table and summary numbers of the abstract submitted to SSAC in September | The September abstract only |
| `node swap_check.js` | What a team gains and loses under Simple COLA by losing one game on purpose to a rival that has waited longer | Section 4.2 |
| `node limits_check.js` | What a team gains by landing just inside the group of teams that picks first, and how teams fare after a top-three pick | Section 5.1 |
| `node design_check.js` | How the simulations were set up, and how the simulated leagues compare with the real NBA | Section 6, Figures 2 and 3 |
| `node results_check.js` | All ten mechanisms on every measure, and how each differs from 3-2-1 | Sections 7 and 8.1, Table 2, Figures 4 to 7 |
| `node draft2026_check.js` | The 2026 draft under each mechanism, from the real 2025-26 standings and playoff results | Section 8.2, Figure 8 |
| `python3 make_figures.py` | Draws the figures into `paper/figures/`, which it creates | Figures 1 to 8 |

Three more scripts check that the stored simulations followed the written
rules of three mechanisms, 3-2-1, Classic COLA and Capped COLA. Classic COLA is
a COLA mechanism that draws the first four picks with chances set by priority.
Capped COLA is one whose tickets grow by a team's wins, up to a cap.

    node t321_adopted_check.js runs/frontier/t321.json
    node verify_classic.js runs/frontier/classic.json
    node verify_capped.js runs/frontier/capped.json

## The simulations and the data

The simulator is [ZenGM Basketball-GM](https://github.com/zengm-games/zengm),
a basketball management game whose code is public. It builds fictional leagues
shaped like the NBA, with 30 teams that each play 82 games a season. It plays
every game, and its built-in computer managers make every trade, contract
signing, and draft choice for all 30 teams. Our code sets the first-round draft
order under each mechanism, and the simulator does everything else.

A simulated league depends on chance at every step, from the players it starts
with to each shot and each lottery drawing. One number, called a random seed,
fixes every chance event. A given seed and mechanism therefore always produce
the same league. All ten mechanisms run on the same 30 seeds, so the paper can
compare any two of them league by league.

`testbed/harness/runs/frontier/` holds the result file of each mechanism, with
30 leagues of 25 seasons in each. `testbed/harness/data/nba-data.json` holds
the NBA's standings, playoff results, and first-round picks from 1999-00 to
2025-26, with 2025-26 as it stood after the first round of the 2026 playoffs.
They were compiled from
[Basketball Reference](https://www.basketball-reference.com/), a public
statistics website. `testbed/harness/README.md` describes both file formats and
how to run the simulations again. A full rerun needs the simulator and takes
about 12 hours on our machine, with three processes at a time.

## License

The code and result files in this repository are released under the MIT
License (see `LICENSE`). Two things sit outside it:

- `original-study/` holds the code and data of the earlier study, by its own
  authors. It is included for reference and keeps its original terms.
- The simulator, ZenGM Basketball-GM, is not part of this repository. It is
  available from its developer under its own license, which is not an
  open-source license.

The NBA standings, playoff results, and draft picks in
`testbed/harness/data/nba-data.json` are facts compiled from Basketball
Reference, shared here so the results can be reproduced.

## Earlier work

A preprint is a paper shared publicly before peer review. An earlier preprint
on COLA is Highley, Duncan, and Volkov (2026),
[Carry-Over Lottery Allocation: Practical Incentive-Compatible Drafts](https://arxiv.org/abs/2602.02487).
Its code and data are in `original-study/`, merged with their full commit
history from <https://github.com/vilka-9999/carry_over_lotter_allocation_research>.

Two interactive pages come from earlier work on COLA, before this paper. The
[COLA Explorer](https://kvr06-ai.github.io/cola-manipulation-bound/) shows how
26 years of NBA drafts would have gone under five versions of COLA. The
[results page](https://kvr06-ai.github.io/cola-manipulation-bound/sweep/) shows
the simulations of an earlier draft, with 48 leagues of 15 seasons for each
mechanism, and a playground that runs three lotteries on team histories you
enter. Its source is in `results-page/`.
