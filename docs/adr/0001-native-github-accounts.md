# ADR: private native GitHub login per Relay user

Date: 2026-09-18. Status: accepted for the GitHub MVP implementation.

## Decision

Run the installed GitHub CLI's supported `gh auth login --web` flow with the
host fixed to `github.com`, HTTPS Git transport, and a fresh 0700 temporary
profile per attempt. Return immediately with a starting state. Extract only
the one-time device code; provide the fixed GitHub verification URL. Never
open a browser on the controller or return raw CLI output.

Do not accept personal-access-token input or import the server's current
GitHub identity. The native child receives a minimal environment with its
own HOME, XDG and GH configuration paths, no inherited token variables,
keyring session, SSH agent, browser command, or global Git configuration.

The CLI uses `--insecure-storage` **inside this temporary private profile** so
it cannot write credentials to a shared OS keyring. On completion the
controller extracts the token, deletes the temporary profile, validates the
GitHub identity, and stores the credential in the user's encrypted record
namespace. Profiles are also deleted on cancel, error, expiry and graceful
shutdown. A machine crash/SIGKILL can leave temporary CLI files; filesystem
permissions are not an isolation boundary against another process running
under the same OS account. Deploy controllers separately from untrusted
workers and use encrypted storage. This limitation is not represented as
end-to-end credential isolation.

Newly authenticated connections grant **no companies**. Only after GitHub
identifies the account does the user name it and explicitly select company
availability; repositories are selected separately when creating chats.
Reconnect preserves the selected connection ID/scope, and rejects another
GitHub identity rather than transferring access silently. Concurrent matching
connections require explicit selection. Existing saved credentials are not
deleted by this upgrade and never gain a global grant.

Pending codes/process handles live only in memory. Durable starting records
become disconnected with an actionable reconnect message after restart.
Successful encrypted credentials survive restart. Cancel invalidates the
in-flight flow before queued identity verification can persist late credentials.

## Verification distinction

The user explicitly authorized local credential copies for isolated testing
while away. The read-only smoke harness may seed an isolated encrypted test
database from a specifically named host CLI account, but this is **not** an
HTTP product feature and does not claim new browser OAuth consent. The user
still completes the interactive sign-in acceptance when available.

References: [GitHub CLI login](https://cli.github.com/manual/gh_auth_login),
[GitHub CLI environment](https://cli.github.com/manual/gh_help_environment).
