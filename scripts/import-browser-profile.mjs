#!/usr/bin/env node
// Package the sign-in state of a local Chrome user-data-dir for upload as an
// Agent Relay browser profile. Only allowlisted files are archived (cookies,
// saved logins, site storage); caches, history and locks are left behind.
// Close every Chrome window using the directory first so its databases are flushed.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProfileArchive, inspectProfileArchive } from "../src/browser-profiles.mjs";

const [directory, flag, output] = process.argv.slice(2);
if (!directory || flag !== "--out" || !output) {
  console.error("Usage: node scripts/import-browser-profile.mjs <chrome-user-data-dir> --out profile.tar.gz");
  process.exit(2);
}
try {
  const archive = await buildProfileArchive(path.resolve(directory));
  const details = await inspectProfileArchive(archive);
  await writeFile(output, archive, { mode: 0o600 });
  console.log(`Wrote ${output} (${(archive.length / 1024 / 1024).toFixed(1)} MB, ${details.files} entries, Chrome ${details.chromeVersion || "unknown"}).`);
  console.log(`Signed-in sites: ${details.sites.slice(0, 15).join(", ") || "none"}`);
  console.log("Upload it from Environments → Browser profile. Treat the file like a password: it signs in as you.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
