# Finalize the worker SSH authorization boundary explicitly

Status: implemented; rebake and fresh AWS acceptance are still required.

The fresh-worker receipt for the previous image rejected exactly one unexpected
`authorized_keys` file. Every other credential category was zero. That receipt
does not identify whether the file belonged to root or the agent, and no file
contents were fetched. Source inspection confirmed that the finalizer removed
root SSH state but omitted `/home/agent/.ssh`; its final credential filename
scan also omitted authorized keys. This is a confirmed coverage defect matching
the failure, not proof of the particular AWS file's origin.

The disposable image finalizer now removes only the two exact nontransport SSH
directories, verifies their absence, and requires that the sole retained SSH
authorization file is the deployment public key in Ubuntu's private `.ssh`
directory. It checks ordinary files/directories, ownership, permissions and exact bytes.
Unknown users' authorized keys and alternate `authorized_keys2` files cause a
fixed error before the finalized marker; they are not silently deleted. The
fresh-worker image audit remains unchanged and rejects either known unexpected
key path. No provider keys, tokens, private transport key or credential contents
are present in the image or diagnostics.

Offline tests execute the actual shell block against isolated temporary paths,
covering both stale builder keys, removal failures, surviving directories,
unknown/alternate keys, changed key bytes, permissive modes and symlinks. These
fixtures cannot establish that a real fresh AWS worker passes; the root-owned
bake and fresh/stop-start acceptance operator remains that gate.
