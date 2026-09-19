import { rm } from "node:fs/promises";
import path from "node:path";

export function previewFixtureEnvironment(directory, executable) {
  const fixtureHome = path.join(directory, "home");
  // Override SDK default metadata too; never inherit operator credentials,
  // browser profiles, proxy variables, provider caches or a real HOME.
  return { HOME: fixtureHome, TMPDIR: path.join(directory, "tmp"), PATH: `${path.dirname(executable)}:/usr/bin:/bin`, LANG: "C.UTF-8",
    USER: "fixture", LOGNAME: "fixture", SHELL: "/bin/false", TERM: "dumb", XDG_CONFIG_HOME: path.join(fixtureHome, ".config"), XDG_CACHE_HOME: path.join(fixtureHome, ".cache") };
}

export async function boundedFixtureOperation(promise, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Fixture operation timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Only resources created by this local fixture are accepted. In particular,
// transportClosed observes the SDK's exact child 'close', not merely close()'s
// bounded termination request. Never delete private evidence on uncertain exit.
export async function cleanupPreviewBootstrapFixture({ client, transport, transportClosed,
  bootstrap, server, sockets, directory }, { timeoutMs = 6000, remove = rm } = {}) {
  let confirmed = true;
  const attempt = async operation => {
    try { await boundedFixtureOperation(Promise.resolve().then(operation), timeoutMs); }
    catch { confirmed = false; }
  };
  if (client) await attempt(async () => {
    const result = await client.callTool({ name: "browser_close", arguments: {} }, undefined, { timeout: timeoutMs });
    if (result?.isError) throw Error("Browser closure unconfirmed");
  });
  if (client) await attempt(() => client.close());
  if (transport) await attempt(async () => {
    if (!transportClosed || typeof transportClosed.then !== "function") throw Error("Child closure observer required");
    await Promise.all([transport.close(), transportClosed]);
  });
  await attempt(() => bootstrap?.close());
  for (const socket of sockets || []) await attempt(() => socket.destroy());
  if (server) await attempt(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(Error("Fixture listener closure unconfirmed")) : resolve());
  }));
  if (confirmed) await attempt(() => remove(directory, { recursive: true, force: true }));
  return confirmed;
}

export function previewBootstrapReceipt(receipt, failure, cleanupConfirmed) {
  if (failure) return { ...failure, cleanupConfirmed };
  if (!cleanupConfirmed || !receipt) return { ok: false, fixtureOnly: true, phase: "cleanup-unconfirmed", cleanupConfirmed: false };
  return { ...receipt, ok: true, cleanupConfirmed: true };
}
