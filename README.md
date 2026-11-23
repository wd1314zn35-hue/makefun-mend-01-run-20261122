# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wd1314zn35-hue/makefun-mend-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wd1314zn35-hue/makefun-mend-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a zero-dependency Node 22 command-line patch applier. It handles unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edit commands with safe paths, fuzzy matching, atomic writes, and check mode.

The implementation was built for the [make.fun Build mend bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). The public practice suite passes 100 of 100 checks.

```text
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```
