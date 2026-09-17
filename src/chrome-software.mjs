// Run only on the selected worker, using a private install/cache directory.
// Existing system Chrome is preferred; no sudo or host browser profile access.
export async function prepareChrome(executor, capture, onProgress = () => {}, executable = "google-chrome") {
  const env = { PATH: executor.environmentPath || executor.backend?.config.ec2.remotePath || process.env.PATH,
    HOME: executor.runtimeHome, LANG: "C.UTF-8", CI: "1", npm_config_update_notifier: "false" };
  const options = { cwd: executor.workspace, env };
  if (executable !== "google-chrome") {
    await capture(executor, executable, ["--version"], options); return executable;
  }
  const installed = await capture(executor, "/bin/sh", ["-c", "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true"], options);
  if (installed.trim()) return installed.trim().split("\n")[0];
  const prefix = `${executor.runtimeHome}/shared-chrome`;
  await executor.mkdir(prefix);
  const saved = await capture(executor, "/bin/sh", ["-c", 'test -x "$1" && printf ready || true', "chrome-check", `${prefix}/google-chrome`], options);
  if (saved === "ready") return `${prefix}/google-chrome`;
  await onProgress("Installing Chrome for Testing in this worker…");
  const output = await capture(executor, "npm", ["exec", "--yes", "--package=@puppeteer/browsers@3.2.2", "--", "browsers", "install", "chrome@stable", "--path", `${prefix}/cache`], options);
  const target = output.split("\n").map(line => /^chrome@[^ ]+\s+(.+)$/.exec(line)?.[1]).find(value => value?.startsWith(`${prefix}/cache/`) && !value.includes("\0"));
  if (!target) throw new Error("Chrome installation did not report an executable. Install Chrome in the worker image or configure AGENT_CHROME_BIN.");
  await capture(executor, target, ["--version"], options);
  await capture(executor, "ln", ["-sfn", target, `${prefix}/google-chrome`], options);
  return `${prefix}/google-chrome`;
}
