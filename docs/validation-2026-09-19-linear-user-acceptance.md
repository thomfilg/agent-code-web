# Deployed Linear and side-chat user acceptance — 2026-09-19

The user performed the check in the deployed g2i chat and supplied screenshots
and the final answer in this conversation. Initially the agent only advertised
Linear capabilities; that statement alone was not accepted as a provider read.
The user then requested their assigned project issues. The transcript reported
five tool calls and returned three issue records. The user separately reported
that `/btw` worked well, with a side answer while the main conversation continued.

This is **user-reported successful selected-chat Linear read and side-chat
acceptance**. It is stronger than a Connected badge or tool inventory. It is not
an independent operator inspection of native tool arguments/results, and it does
not establish a same-connection read or native account resume after worker restart.
The baseline read need not be requested again. Ticket IDs, titles and returned
workspace content are deliberately omitted from this receipt.

Last independently verified deployed build: `d9c0ce6` (runtime `8db8247`). The
new MCP error-visibility candidate `94860e7` was built but not deployed, and no
worker was restarted during these user checks. The separate startup parallelism
and stage-timing request is being implemented; company-scoped caches and prepared
environment reuse were explicitly deferred to post-MVP by the user.

## Unexpected response language

The initial answer was Russian despite an English request. A read-only source
review found no Russian-forcing instruction in Relay. The injected Shared Chrome
instructions explain mentioning that tool, but do not explain the language.
Named accounts use per-chat profiles; no host instruction import was demonstrated.
The actual worker's repository instructions and native history were not inspected,
so the cause is unproven. The agent's later self-explanation is not forensic proof.
The user requested English and subsequent supplied answers were in English.

No credentials, private profile contents or provider data were copied or changed
to obtain this acceptance. No new operator-generated model prompt was submitted.
