#!/usr/bin/env node
// Minimal --help/--version responder for ModelCatalog.claude() tests. Each
// test writes its own copy with the version/fable-mention it needs baked in,
// since the real ModelCatalog never forwards arbitrary env vars to the CLI.
const version = "__VERSION__";
const mentionsFable = __MENTIONS_FABLE__;
if (process.argv.includes("--version")) { process.stdout.write(`${version}\n`); process.exit(0); }
if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: claude [options]\n--effort <level>\n  (low,medium,high,xhigh,max)\n${mentionsFable ? "  fable is available on eligible accounts\n" : ""}`);
  process.exit(0);
}
process.exit(1);
