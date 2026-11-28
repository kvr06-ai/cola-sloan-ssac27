# The interactive results page

`index.html` is the source of a results page that was published at
kvr06-ai.github.io/cola-manipulation-bound/sweep/ and is no longer online. The
page holds results tables and a lottery playground, which redraws three
lotteries (the NBA's 2019 lottery, Classic COLA and Waitlist COLA) 20,000 times
for any set of team histories. It is one self-contained file with no external
dependencies, so it runs when opened in a browser.

The page shows the runs of an earlier draft, 48 leagues of 15 seasons per
mechanism, and its numbers came from the scripts in
`../testbed/harness/earlier-analyses/`.

## Publishing

The page was published from the `docs/sweep/` folder of the
`cola-manipulation-bound` repository, which is now private, so the page's link
to that repository no longer opens. `sh ./deploy.sh` copies `index.html` into a
checkout of that repository, whose path it takes as an optional argument.
