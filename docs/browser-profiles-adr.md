# ADR: Saved browser profiles for the guest Chrome

Status: accepted · 2026-09-23

## Context

The guest Chrome started every chat from an empty, throwaway profile. To let an
agent work on sites the owner already signs into, the owner can now supply a
Chrome profile. Accounts placed in a profile are a sandbox the owner hands to
the agent: the agent may use them freely. The protection is about isolation and
undo, not about restricting what the agent does on those sites.

## Decision

- **A profile is an immutable, versioned snapshot** (`browser-profile` record,
  company scoped like environments). Each version is a `.tar.gz` of an allowlist
  of the user-data-dir: `Local State`, `Last Version`, `Default/{Cookies, Login
  Data, Web Data, Preferences, Local Storage, Session Storage, IndexedDB, Local
  Extension Settings}`. Caches, history and locks are never stored, which turns a
  ~400 MB profile into ~1 MB. Archives are stored as sealed records
  (`browser-profile-archive`), so they share the database encryption key and
  backups. At most 20 versions are kept.
- **Selected per environment** (`environment.browserProfileId`). The profile and
  the environment must belong to the same company.
- **One private copy per chat.** The first time a chat's browser opens, the
  current version is extracted to `<runtime-home>/.relay-browser-profile` and
  pinned there. The copy survives browser idle stops and worker sleep and is
  deleted with the chat (local chat directory / EC2 instance termination).
  Chats never share a copy, and later versions never reach an existing copy.
- **Nothing is written back automatically.** The only write path is the owner's
  explicit “Save to profile” in the Browser panel, which stops Chrome so its
  databases are flushed, archives the chat copy and publishes the next version.
  The same path creates a profile from scratch: create an empty profile, sign in
  from a chat's Browser panel, save.
- **Portable cookies only.** Chrome runs with `--password-store=basic`, so
  cookies are encrypted with Chromium's fixed key (`v10`). Uploads whose cookies
  are bound to the source machine's keyring (`v11`) are rejected with guidance.
- **Chrome is always the current stable.** Worker images upgrade
  `google-chrome-stable` at every boot (`agent-web-chrome-update.service`). If a
  profile was written by a newer Chrome than the worker has, the current Chrome
  for Testing stable build is installed privately for that worker instead of
  opening the profile with an older browser.

## Consequences

- Undo covers browser state only. Actions the agent takes on a site (deleting a
  task, sending a message) happen on that site and are not undone.
- A site may invalidate the snapshot's session (logout, password change, token
  rotation). Refresh it by signing in again from a chat and saving a new version.
- The Chrome UI is headless, so extension popups and Chrome's own password save
  prompts are not shown; saved passwords are only updated by uploading a new
  archive.
- Import from a desktop profile: close Chrome, then run
  `node scripts/import-browser-profile.mjs <user-data-dir> --out profile.tar.gz`
  and upload the file in Environments → Browser profile.
