# Hibernation lifecycle contract — September 20, 2026

This receipt closes partition 1 of the
[hibernation implementation checklist](hibernation-implementation-checklist.md).
It is preparatory source and local acceptance. It does **not** enable automatic
hibernation, claim that native processes can reconnect, or prove an AWS image.

## Persisted contract

`src/worker-lifecycle.mjs` defines a bounded versioned record with:

- a monotonic generation and separate operation intent/result;
- explicit `stopped`, `active`, `suspended`, `unknown`, `failed` and transition
  states;
- exact sanitized worker identity and a public controller-lease descriptor;
- `created`, `started` and `inspected` acquisition results;
- cleanup results that distinguish no mutation, confirmed stop, uncertain
  cleanup and failed cleanup; and
- bounded timestamps with no credential/token/secret field. A controller lease
  containing private authority is rejected instead of partially persisted.

The EC2 backend publishes exact mutation cleanup authority synchronously and
returns an acquisition receipt. An existing running worker returns `inspected`
without cleanup authority; a stopped worker returns `started`; a new instance
returns `created`. RuntimeManager persists intent before backend acquisition,
persists the observed result with runtime metadata, and records explicit Stop
and Delete results. A stale callback cannot write across a newer generation.

`ChatStore.initialize` clears the previous controller lease and changes any
saved worker observation, in-flight transition or malformed lifecycle to
`unknown`/`reconcile`. A saved row alone therefore cannot authorize a presumed
live process. Legacy exact EC2 metadata is migrated to the same unknown state.

## Deterministic acceptance

The focused command below passed **77/77**:

```sh
node --test test/worker-lifecycle.test.mjs test/hibernation-lifecycle.test.mjs test/ec2-backend.test.mjs test/parallel-worker-startup.test.mjs test/worker-wake.test.mjs test/store-workspace.test.mjs test/settings.test.mjs test/runtime-manager.test.mjs
```

Coverage includes intent persistence failure before any backend call, result
persistence failure after an exact mutation, completed/failed cleanup, Stop and
Delete failures, old-generation callbacks, malformed/foreign worker identity,
controller restart fencing, existing nonaccepted workers, late EC2 mutation,
parallel repository/machine startup, and exact idempotent cleanup ownership.

The complete Node regression then passed **1,609**, failed **0** and skipped
**4** optional cases (**1,613 total**) with the checked-in test command
`taskset -c 0,1 nice -n 10 npm test`.

## Remaining boundary

`src/worker-suspension.mjs` still returns `available: false`. Production EC2
execution still uses the controller-owned SSH child transport, so controller
detach would end native processes. Partitions 2–6 remain required: production
worker-owned transport, credential revalidation, the two-minute state machine,
hibernation-capable image/watchdog evidence, disposable live preservation tests
and separately coordinated activation. No production timer or flag changed.
