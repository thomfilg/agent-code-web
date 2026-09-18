import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const pluginVersion = "1.2.835.0";
export const pluginSigner = "7959637124CE093AD501D47A2C4D4AFF6F6757EE";
export const pluginPackageUrl = `https://s3.amazonaws.com/session-manager-downloads/plugin/${pluginVersion}/ubuntu_64bit/session-manager-plugin.deb`;

// No global installation, user GPG keyring, sudo, unpinned latest or scripts
// from an unverified package. Called only after the operator's explicit --run.
export async function prepareSessionPlugin(directory, { run, fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "linux" || arch !== "x64") throw Error("Native acceptance requires a Linux x86_64 operator");
  const root = path.join(directory, "plugin"), keyring = path.join(root, "gpg");
  await mkdir(root, { mode: 0o700 }); await mkdir(keyring, { mode: 0o700 });
  const key = path.join(root, "signer.asc");
  await writeFile(key, await readFile(new URL("./session-manager-signing-key.asc", import.meta.url)), { mode: 0o600, flag: "wx" });
  for (const [suffix, maximum] of [["", 30 * 1024 * 1024], [".sig", 16384]]) {
    const response = await fetchImpl(pluginPackageUrl + suffix, { redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error("Signed Session Manager package download failed");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) { await response.body.cancel().catch(() => {}); throw Error("Session Manager package exceeds its size limit"); }
      chunks.push(chunk);
    }
    await writeFile(path.join(root, "plugin.deb" + suffix), Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
  }
  const common = ["--no-options", "--batch", "--homedir", keyring];
  await run("gpg", [...common, "--import", key]);
  const keys = await run("gpg", [...common, "--with-colons", "--fingerprint", "--list-keys"]);
  const fingerprints = keys.split("\n").filter(line => line.startsWith("fpr:")).map(line => line.split(":")[9]);
  if (fingerprints.length !== 1 || fingerprints[0] !== pluginSigner) throw Error("Unexpected Session Manager signing key");
  const receipt = await run("gpg", [...common, "--status-fd", "1", "--verify", path.join(root, "plugin.deb.sig"), path.join(root, "plugin.deb")]);
  if (!receipt.split("\n").some(line => line.startsWith(`[GNUPG:] VALIDSIG ${pluginSigner} `))) throw Error("Session Manager package signature did not verify");
  const extracted = path.join(root, "extracted");
  await run("dpkg-deb", ["--extract", path.join(root, "plugin.deb"), extracted]);
  const binary = path.join(extracted, "usr/local/sessionmanagerplugin/bin/session-manager-plugin");
  if ((await run(binary, ["--version"])).trim() !== pluginVersion) throw Error("Unexpected Session Manager plugin version");
  return { binary, version: pluginVersion };
}
