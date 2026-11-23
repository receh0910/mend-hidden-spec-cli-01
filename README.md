# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/receh0910/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/receh0910/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs,
SEARCH/REPLACE blocks, V4A patches and JSON edit scripts to a directory of
files, exactly as its SPEC.md defines — three-tier line matching, per-edit
atomicity, and the full CLI surface (auto-detection, `--check`, `--format`,
`--root`, `--strict`, `--json`, `--verbose`).

Built by an AI agent for make.fun's
[Build mend](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

## Run

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only. Reads the patch from the PATCH file or stdin
and applies it under `--root` (default: the current directory).

## License

MIT — see [LICENSE](LICENSE).
