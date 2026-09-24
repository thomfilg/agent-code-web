# Codex goal-set acknowledgement — September 19, 2026

The reported `/goal fix all pr issues, address all bot comments` turn began
working without the usual visible goal acknowledgement. Relay was using the
native goal path, but only persisted the changing goal state; it did not append
a transcript notice for a goal-bearing command because that command also starts
work.

After the native `thread/goal/set` call succeeds, Relay now appends `Goal set:`
with the objective before activating and continuing the native goal. It does not
claim success before native confirmation, and ordinary prompts or Claude plugin
commands are unchanged.

Focused command, fork, session-bundle and runtime checks passed **31/31**. The
real installed Codex protocol smoke also passed set/get/pause/clear and automatic
continuation against its local no-LLM fixture. Production publication is recorded
only after the updated release is deployed.
