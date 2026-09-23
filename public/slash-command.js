const validName = /^[\w:.-]+$/;

// A leading slash is always command syntax. Paths and malformed command names
// must be written as ordinary prose (for example, "inspect /tmp/project") so
// they can never slip through as an accidental agent prompt.
export function parseSlashCommand(text) {
  const value = String(text ?? "").trim();
  if (!value.startsWith("/")) return null;
  const separator = value.search(/\s/);
  const token = separator < 0 ? value : value.slice(0, separator);
  const rawName = token.slice(1);
  return {
    name: validName.test(rawName) ? rawName : null,
    rawName,
    argument: separator < 0 ? "" : value.slice(separator).trim(),
  };
}

export function invalidSlashCommandError() {
  return new Error("Invalid slash command. Use /command followed by optional arguments; write file paths inside an ordinary sentence.");
}
