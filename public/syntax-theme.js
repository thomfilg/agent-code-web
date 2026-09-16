export const DEFAULT_SYNTAX_THEME = "relay-dark";
export const SYNTAX_THEMES = [
  { id: "relay-dark", label: "Relay dark", description: "Soft colors on a dark background" },
  { id: "paper-light", label: "Paper light", description: "Dark ink on a light code surface" },
  { id: "high-contrast", label: "High contrast", description: "Bright, distinct colors on black" },
  { id: "plain", label: "Plain", description: "No syntax colors; diff additions and removals stay marked" },
];
export function validateSyntaxTheme(value) {
  if (!SYNTAX_THEMES.some(theme => theme.id === value)) throw Object.assign(new Error("Choose a listed syntax theme."), { statusCode: 400 });
  return value;
}

// Both asset paths and modes are an explicit allowlist, never derived from code
// or a user-supplied URL. The worker owns a separate, minimal CodeMirror runtime.
const languages = [
  ["javascript js mjs cjs", ["javascript"], "text/javascript"],
  ["typescript ts", ["javascript"], "text/typescript"],
  ["jsx", ["xml", "javascript", "jsx"], "text/jsx"],
  ["tsx", ["xml", "javascript", "jsx"], "text/typescript-jsx"],
  ["json jsonc", ["javascript"], "application/json"],
  ["html htm", ["xml", "javascript", "css", "htmlmixed"], "text/html"],
  ["xml svg", ["xml"], "application/xml"],
  ["css", ["css"], "text/css"],
  ["scss", ["css"], "text/x-scss"],
  ["less", ["css"], "text/x-less"],
  ["python py", ["python"], "text/x-python"],
  ["bash sh shell zsh", ["shell"], "text/x-sh"],
  ["sql", ["sql"], "text/x-sql"],
  ["yaml yml", ["yaml"], "text/x-yaml"],
  ["toml", ["toml"], "text/x-toml"],
  ["diff patch", ["diff"], "text/x-diff"],
  ["go golang", ["go"], "text/x-go"],
  ["rust rs", ["rust"], "text/x-rustsrc"],
  ["ruby rb", ["ruby"], "text/x-ruby"],
  ["c h", ["clike"], "text/x-csrc"],
  ["cpp c++ hpp", ["clike"], "text/x-c++src"],
  ["java", ["clike"], "text/x-java"],
  ["csharp cs c#", ["clike"], "text/x-csharp"],
  ["kotlin kt", ["clike"], "text/x-kotlin"],
  ["markdown md", ["xml", "markdown"], "text/x-markdown"],
];
export const SYNTAX_MODES = [...new Set(languages.flatMap(([, modes]) => modes))];
const aliases = new Map(languages.flatMap(([names, assets, mode]) => names.split(" ").map(name => [name, { assets, mode }])));
export function syntaxLanguage(language) { return typeof language === "string" ? aliases.get(language.toLowerCase()) || null : null; }
export const MAX_SYNTAX_LENGTH = 80000, MAX_SYNTAX_TOKENS = 5000;
export function canHighlight(source) { return typeof source === "string" && source.length > 0 && source.length <= MAX_SYNTAX_LENGTH && source.split(/\r\n|\r|\n/).every(line => line.length <= 4000); }
const styles = new Set("keyword atom number def variable variable-2 variable-3 property operator comment string string-2 meta qualifier builtin bracket tag attribute type error header quote link strong em positive negative".split(" "));
export function syntaxStyle(style) { return typeof style === "string" ? style.split(/\s+/).filter(value => styles.has(value)).map(value => `syntax-${value}`).join(" ") : ""; }

// Preserve the exact source, including tabs and CRLF. runMode's DOM helper
// expands tabs and normalizes newlines, so use offsets instead of its markup.
export function syntaxTokens(library, source, mode) {
  if (!canHighlight(source)) return null;
  const starts = [0]; for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  const tokens = [];
  library.runMode(source, mode, (text, style, line, column) => {
    const className = syntaxStyle(style); if (!className || line === undefined) return;
    if (tokens.length >= MAX_SYNTAX_TOKENS) throw new Error("Highlight token limit reached");
    const start = starts[line] + column, end = start + text.length, previous = tokens.at(-1);
    if (previous && previous[1] === start && previous[2] === className) previous[1] = end;
    else tokens.push([start, end, className]);
  });
  return tokens;
}
