# Pinned AWS deployment engine

`aws.mjs` and `aws-rollout.py` are the exact runtime files from
[`12-apps/ci`](https://github.com/12-apps/ci) commit
`848182b33461640e9ac0feb7315f747a67877c88` (`2026-09-18`).

Their reviewed SHA-256 digests are pinned and verified by
`scripts/aws-deploy.mjs` before every operation. Update the source files,
revision and hashes together after reviewing a newer upstream commit.

The repository copy is the default. `CI_AWS_ENGINE` remains available only as
an explicit absolute-path override to the same clean upstream revision and
must match the pinned hashes.
