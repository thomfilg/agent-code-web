# One-shot local controller restart

`scripts/restart-local-relay.mjs` is a Linux operator tool for the existing local
installation, not a product login option, credential importer, daemon installer,
or AWS deployer. Its default mode is read-only. It never calls Doppler or creates
a service token. Run it with the same OS user and Node executable as the server.

The current controller was started inside a `dbus-run-session` login. Stopping
that controller can tear down the session bus used by Doppler's CLI keyring.
The tool captures the already-loaded `code-web/dev` environment **in memory
before shutdown**, validates it through the existing Doppler launcher, removes
the Doppler token and old bus/keyring/SSH-agent/inspector handles, then launches
the newest committed application with `scripts/doppler.mjs --injected start`.
This preserves the loaded configuration; it does **not** fetch recent Doppler
changes. Future fresh Doppler launches may require CLI authentication again.

## Operator sequence

Use the actual server PID, not its npm/Doppler/dbus wrapper. Do not copy these
values to another machine or reuse a receipt after its process or commit changes.

```sh
taskset -c 0,1 nice -n 10 node scripts/restart-local-relay.mjs --pid 37926
```

Inspection verifies the exact UID, process start ticks, executable, two-argument
server command, repository cwd, committed application source, loopback port 8787,
the expected private control directory and workspace directory, exact embedded
PostgreSQL process/listener, and absence of other controller children. It reads
existing records in a read-only SQL transaction; it does not initialize the DB,
mint a browser session, impersonate a user, or save records. Encryption-check must
pass; active/queued chats, pending approval, active goals, or pending native agent
accounts refuse the restart. The public receipt contains no records or secrets.

For a server with the deployment drain endpoint, execution must additionally
acquire its atomic idle gate. A legacy controller without `/readyz` cannot expose
all memory-only GitHub/MCP OAuth flows or prevent a new request after inspection.
There is deliberately **no claim that a database snapshot proves these absent**.
For this one legacy bootstrap, the operator must establish a maintenance window
with no users interacting and no pending browser consent, then explicitly pass
`--legacy-idle-confirmed`. Without it execution refuses before stopping anything.

After reviewing the receipt and confirming maintenance:

```sh
taskset -c 0,1 nice -n 10 node scripts/restart-local-relay.mjs \
  --pid 37926 --start-ticks TICKS_FROM_INSPECTION \
  --expected-revision FORTY_CHARACTER_COMMIT_FROM_INSPECTION \
  --execute --legacy-idle-confirmed
```

The execute path reserves an exclusive operator lock, rechecks process/source and
database state, drains supported controllers, and sends SIGTERM **only to the
verified server PID**, using Linux pidfd signaling to avoid PID-reuse races. It
never kills dbus, keyring, PostgreSQL, process groups,
other Node servers, or a reused PID. There is no SIGKILL fallback. Copying starts
only after both exact old processes have exited, both listeners are absent, and
PostgreSQL's PID file is gone.

The cold checkpoint is retained under
`~/.local/share/agent-code-web-restart-backups/checkpoint-*` (directory 0700,
archives/manifest/log 0600). It includes the complete controller directory,
especially `local-credentials.json`, embedded PostgreSQL and the app data tree.
It does not enumerate or copy unrelated browser/CLI profiles. Tar does not follow
symlinks or cross filesystem boundaries. These archives contain the encryption
key alongside the encrypted records and may contain workspace credentials: treat
them as highly sensitive, do not upload or commit them. No automatic expiration,
deletion, restore, or broad cleanup occurs.

Only after the cold checkpoint does the tool start one detached controller. The
private log records fixed operator stages only; raw application stdout/stderr
is discarded, not written to a possibly secret-bearing crash log. Readiness must
be 200 from a listener owned by the exact new server child. Existing browser
Google sessions survive through the same encrypted DB/session secret.

## Failure behavior and boundaries

- An unverified identity, unexpected listener, busy DB or drain rejection does
  not authorize stopping anything. A drain failure attempts to resume only the
  still-identical original controller.
- A stop timeout or leftover PostgreSQL PID/listener never triggers a force kill
  or second controller. The operator reports that manual inspection is required.
- After a verified stop, archive or startup failure permits one direct startup
  attempt with the same captured environment and **current code**, only after
  exact failed-launch processes exit and the source is cold again. This is service
  recovery, **not an old-code rollback**. A failed checkpoint is not reported as
  complete. Partial and complete archives are retained.
- Failed new processes receive graceful SIGTERM only by captured identity; an
  ambiguous or unobserved child blocks retry. If the second attempt fails, inspect
  the exact process state; do not blindly invoke this tool again.
- Killing the operator itself after shutdown loses its in-memory environment and
  recovery logic. This is a supervised one-shot local operation, not the AWS
  independent watchdog design. Leave the operator alive until its final receipt.
- The tool does not restore archives over live data, change the encryption key,
  import provider credentials, authorize browser consent, or send model prompts.

Local tests use synthetic records/process fixtures. A passing test is not proof
that the real local restart happened or that browser consent succeeded.
