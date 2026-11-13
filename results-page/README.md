# The interactive results page

`index.html` is the source of the public page at
<https://kvr06-ai.github.io/cola-manipulation-bound/sweep/>. The page holds
results tables and a lottery playground, which redraws three lotteries (the
NBA's 2019 lottery, Classic COLA and Waitlist COLA) 20,000 times for any set of
team histories. It is one self-contained file with no external dependencies.

The page shows the runs of an earlier draft, 48 leagues of 15 seasons per
mechanism, and its numbers came from the scripts in
`../testbed/harness/earlier-analyses/`. It will be rebuilt from the
nine-mechanism run behind the paper.

## Publishing

GitHub Pages serves the page from the `docs/sweep/` folder of the
`cola-manipulation-bound` repository. `./deploy.sh` copies `index.html` into a
checkout of that repository, whose path it takes as an optional argument.
Commit and push that repository to publish the page.
