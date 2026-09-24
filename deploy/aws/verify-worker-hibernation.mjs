#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseVerificationOptions, verifyHibernationImage } from "./verify-worker-ami.mjs";

export { parseVerificationOptions, verifyHibernationImage };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await verifyHibernationImage(parseVerificationOptions(process.argv.slice(2)), { log: message => console.error(message) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
