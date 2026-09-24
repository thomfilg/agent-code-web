// Run only on the selected worker, using a private install/cache directory.
// Existing system Chrome is preferred; no sudo or host browser profile access.
const major = output => Number(/(\d+)\.\d+\.\d+\.\d+/.exec(output || "")?.[1]) || 0;

// minimumMajor: a seeded profile written by a newer Chrome cannot be opened by an
// older one. The image Chrome is used when new enough; otherwise the current
// Chrome for Testing stable build is installed privately for this worker.
export async function prepareChrome(executor, capture, onProgress = () => {}, executable = "google-chrome", { minimumMajor = 0 } = {}) {
  const env = { PATH: executor.environmentPath || executor.backend?.config.ec2.remotePath || process.env.PATH,
    HOME: executor.runtimeHome, LANG: "C.UTF-8", CI: "1", npm_config_update_notifier: "false" };
  const options = { cwd: executor.workspace, env };
  if (executable !== "google-chrome") {
    await capture(executor, executable, ["--version"], options); return executable;
  }
  const installed = await capture(executor, "/bin/sh", ["-c", "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true"], options);
  const system = installed.trim().split("\n")[0];
  const newEnough = async candidate => !minimumMajor || major(await capture(executor, candidate, ["--version"], options).catch(() => "")) >= minimumMajor;
  if (system && await newEnough(system)) return system;
  const prefix = `${executor.runtimeHome}/shared-chrome`;
  await executor.mkdir(prefix);
  const saved = await capture(executor, "/bin/sh", ["-c", 'test -x "$1" && printf ready || true', "chrome-check", `${prefix}/google-chrome`], options);
  if (saved === "ready" && await newEnough(`${prefix}/google-chrome`)) return `${prefix}/google-chrome`;
  await onProgress(system ? "Installing the current stable Chrome for this browser profile…" : "Installing Chrome for Testing in this worker…");
  const output = await capture(executor, "npm", ["exec", "--yes", "--package=@puppeteer/browsers@3.2.2", "--", "browsers", "install", "chrome@stable", "--path", `${prefix}/cache`], options);
  const target = output.split("\n").map(line => /^chrome@[^ ]+\s+(.+)$/.exec(line)?.[1]).find(value => value?.startsWith(`${prefix}/cache/`) && !value.includes("\0"));
  if (!target) throw new Error("Chrome installation did not report an executable. Install Chrome in the worker image or configure AGENT_CHROME_BIN.");
  const installedVersion = await capture(executor, target, ["--version"], options);
  if (minimumMajor && major(installedVersion) < minimumMajor) throw new Error(`This browser profile needs Chrome ${minimumMajor} or newer; the newest available build is ${installedVersion.trim()}.`);
  await capture(executor, "ln", ["-sfn", target, `${prefix}/google-chrome`], options);
  return `${prefix}/google-chrome`;
}
