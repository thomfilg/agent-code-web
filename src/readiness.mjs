import { access, constants } from "node:fs/promises";

// Probe the database/encryption boundary and actual durable directories. A
// static page or successful authentication redirect is not app readiness.
export function readinessProbe({ records, directories, configured = () => true, timeoutMs = 2500 }) {
  let pending;
  return () => pending ||= (async () => {
    let timer;
    try {
      if (!configured()) return false;
      const work = Promise.all([
        records.get("system", "encryption-check").then(value => value?.ok === true || records.kind === "memory-test"),
        ...directories.map(directory => access(directory, constants.R_OK | constants.W_OK).then(() => true)),
      ]).then(results => results.every(Boolean));
      return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } catch { return false; }
    finally { clearTimeout(timer); pending = null; }
  })();
}
