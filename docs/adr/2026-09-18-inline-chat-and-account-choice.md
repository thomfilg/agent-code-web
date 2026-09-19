# Inline new chat and per-project account defaults

Status: accepted product direction, 2026-09-18.

The user's screenshots replace the modal creation form with a page-level
composer. Environment and repository/branch chips sit immediately above the
input. A compact `+` opens repository search; that same interaction remains
available in an existing conversation. Model and effort remain in the composer.
Sending the first message shows preparation feedback immediately and transitions
to the saved conversation without a second confirmation form.

Provider and account are one choice, displayed as `Codex/Claude · name · email`.
The settings gear manages accounts. Connecting an agent account does not require
assigning companies/projects. Any connected account belonging to the signed-in
user may be explicitly selected for any of that user's chats. Other users'
accounts, revoked credentials and wrong-provider bindings remain forbidden.
This supersedes the previous **agent-account** company gate; it does not change
environment, MCP, browser-connection, or GitHub ownership rules.

Remember the last explicitly chosen provider/account by `(Relay user, primary
repository full name)`. Normalize the repository key to lower case. Branches and
secondary repositories do not define a different project. These preferences
are controller records, not browser-local storage or credentials. A disconnected
or removed account is not returned as a usable project default. Existing chats
retain their saved binding and never switch merely because a project default
changed. A new project without a saved default keeps the current valid choice.

Repositories are optional for a scratch chat. Environments must still allow the
selected primary company or an unassigned workspace. No GitHub credential is
needed to start a scratch workspace. Selecting a repository still requires the
user's own GitHub access.

Existing repository addition uses the guarded backend operation: the agent must
be idle, the primary repository stays unchanged, and workspace services stop
before the next wake clones the new repository. Show this consequence before
the explicit Add action. This UI does not promise live filesystem hot-add,
destructive repository removal, or checkout of an existing worker's branch.
Draft repository chips can be removed/reordered and their branches selected
before creation; active chips display the current reported branch.

No change in this decision enables hibernation or automatic deployments.
