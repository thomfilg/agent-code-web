# Worker monitoring: durable events, independent witnesses

Status: durable event ledger, controller-host collector, EC2 queue/consumer,
and worker-supervisor process outbox implemented locally, not yet deployed.
The worker guest-watchdog decision source and current-state projection are still
required. Do not use this document
to claim that a worker survives a controller restart or that a stopped VM is
currently reported in real time.

## Contract

The chat's desired state, the worker's observed state, and the reason for a
transition are distinct facts. Every observation has an exact worker instance
and boot identity, lifecycle generation, source identity, source event ID,
observation time, and ingestion time. A delayed observation for an old worker or
generation is retained for audit but cannot replace the current projection.

Normal delivery is event-driven:

```text
worker supervisor/systemd ── durable local outbox ─┐
controller host Docker events ── durable host outbox ├─> PostgreSQL event rows
EC2 EventBridge ── SQS + DLQ ────────────────────────┘         │
controller lifecycle intent/result ────────────────────────────┘
                                                              │ commit
                                                        PostgreSQL NOTIFY
                                                              │ wake hint
                                                 authenticated SSE + cursor
                                                              │
                                                         browser UI
```

The browser does not poll machine-health every four seconds. The local UI change
loads one snapshot, subscribes to the stream, refreshes on chat/event changes
or when the details panel opens, and reconnects with `Last-Event-ID`. A
server-owned 30-second sampler emits only changed health/anomaly states; it is
independent of browser presence. The
server executes `LISTEN` before its first catch-up query, and repeats catch-up
after reconnect. `NOTIFY` is only a hint; the event row is authoritative.
Writers are idempotent by source event ID. Per-chat sequence numbers serialize
concurrent commits; the stream is at-least-once and ordered by committed
sequence, not by clocks on different machines.

## Failure independence

- Native agent exit: the worker-owned supervisor/systemd records the exit even
  if the agent cannot report its own death. The outbox survives a lost SSH
  transport and daemon restart. A connected controller receives the normal
  process-exit frame and drains the outbox; reconnect and acquisition replay
  anything missed. It ACKs the worker file only after the PostgreSQL commit.
  An idle daemon is upgraded in place, but an older daemon with retained work
  is never restarted just to add monitoring. The outbox contains no prompts,
  output, account credentials, or raw environment variables.
- Relay container exit/OOM: a **host-owned** collector, not a process inside
  that container, records Docker `die`, `oom`, and `health_status`. systemd
  restarts the collector; its outbox is on the persistent controller volume.
  It runs as UID 1000 with only the host Docker group and no network, and
  never mounts the Docker socket into Relay. The host writes an fsynced,
  allowlisted event before advancing its cursor; Relay acknowledges it only
  after an idempotent PostgreSQL commit. A failed database commit leaves the
  file for replay.
- Worker or controller VM stop: EC2 state-change notifications go to SQS with
  a dead-letter queue, independent of the VM and Relay container. Ingestion
  checks queue account, region, and exact saved chat/instance identity before
  retaining an observation. Independent tag verification is still required
  before this can drive the current-state projection. The worker receives no
  AWS role or shared controller key.
- PostgreSQL or SSE outage: source outboxes/SQS retain events. Reconnect
  replays committed rows from the last cursor. Monitoring unavailability raises
  an alert; it must not itself issue a worker Stop.
- Lost source event: AWS labels some service delivery to EventBridge
  *best-effort*, and Docker retains only 256 historical events. A low-rate
  **server-side reconciliation** of AWS instances, Docker state, and persisted
  chat intent is required as a backstop. It is not the normal delivery path and
  the UI never polls. Claiming guaranteed no-loss detection from these event
  sources without reconciliation would be incorrect.

## Acceptance evidence required before removing browser polling

| Injected failure | Required observation |
| --- | --- |
| Agent native process exits | Supervisor exit event and exact process/chat identity; no false idle Stop |
| Relay container OOM or restart | Host event persists and reaches UI after server restart |
| Worker EC2 Stop | AWS event survives a dead controller and is correlated to exact instance |
| EventBridge/SQS duplicate or reordered message | One committed source event; stale event cannot overwrite newer state |
| PostgreSQL notification lost | Cursor catch-up delivers the committed event |
| PostgreSQL unavailable | Source event is retained, later ingested; worker is not stopped because monitoring failed |
| Browser disconnected | Reconnect replays all missed events, without four-second health polling |
| Chat deleted | Event rows and outbox data for that chat are erased under the chat retention policy |

Current local implementation: PostgreSQL per-chat and system event rows with
encrypted payloads, ordered sequence and source-ID deduplication, commit-coupled
`NOTIFY`, reconnecting listener, cursor-replayed authenticated SSE, lifecycle
Stop reason projection/recovery, and host Docker event collector with durable
outbox and deployment gate. The EC2 EventBridge/SQS/DLQ template and
at-least-once consumer are locally tested, but the infrastructure update has
not run. The 5-minute AWS fleet audit and event-driven browser refresh are
also implemented locally. The worker process outbox and commit-before-ACK
replay have local tests, including lost transport, daemon replacement, database
failure, and a no-restart guard for retained work. They are not live-tested.
Guest-watchdog decisions, current-state projection, alert delivery, and live
host-service verification are still required.

References: [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html),
[PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html),
[EC2 EventBridge state changes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/automating_with_eventbridge.html),
[EventBridge delivery levels](https://docs.aws.amazon.com/eventbridge/latest/ref/event-delivery-level.html),
[EventBridge dead-letter queues](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html),
[Docker events](https://docs.docker.com/reference/cli/docker/system/events/).
