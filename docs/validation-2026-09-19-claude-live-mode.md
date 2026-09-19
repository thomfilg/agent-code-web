# Claude live permission-mode selection

The mode dropdown previously only persisted `chat.mode`; an active Claude turn
kept its launch-time policy until a later turn. The manager now sends the native
`set_permission_mode` control to the existing private Claude session and saves
the selection only after an exact native `{ mode }` acknowledgement.

No worker, browser, terminal, message or native session is restarted. This does
not use `bypassPermissions`, approve a pending tool, change allowlists, or turn
off native account/model/policy restrictions. Existing approval requests stay
native-owned; only native cancellation removes them automatically. A native
refusal is reported without exposing its private diagnostic payload.

Concurrent mode changes are rejected while a control is pending. Stop, account
rebinding and generation changes invalidate completion. Native status frames
after acknowledgement remain authoritative, including status frames in the
same stdout chunk and changes during persistence. A receipt-time epoch fences
older queued status observations. The UI waits for confirmation and preserves
the pending approval and unsent draft; delayed responses cannot select another
chat.

## Verification

- 184/184 Node tests passed, serial, covering Claude settings, sessions, trust,
  native MCP control transport, runtime manager and message queue.
- 5/5 targeted browser tests passed, no retries: live Auto pending/success/error,
  existing native Plan transitions and configuration controls at 1280px/320px.
- Adversarial source review identified and corrected acknowledgement/status
  ordering and stale-observation races; deterministic regressions cover both.
- Installed Claude 2.1.222 source inspection confirmed the native control returns its
  accepted mode and rejects unavailable Auto. No authenticated model invocation
  or live user-worker mutation was used for these tests.

This receipt validates code/protocol doubles and browser behavior, not a new
production deployment or a claim that native Auto will approve every command.
