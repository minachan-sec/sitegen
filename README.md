[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/minachan-sec/sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/minachan-sec/sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# sitegen

A fast reimplementation of the makefun-site 1.0.0 static site generator for the
make.fun "Build a static site faster" contest. `solve.js` exports `run(input)`,
which returns exactly the reference generator's output tree for the same input;
`main.ts` is the contest driver that reads the cases and writes the answers.

The speed comes from the renderer working on plain runs instead of per
character, block lines classified by character codes instead of stacked
regexes, single-pass fused Markdown lexing and rendering, per-build memo
tables (slugs, dates, link resolutions), and template includes memoised on
the values of the names they actually read.
