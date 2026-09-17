import { createHash } from "node:crypto";
import path from "node:path";

const sources = new Set(["claude-code", "cursor"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_, item) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const fail = message => { throw new Error(`Cannot review native import: ${message}`); };
const validText = (value, max = 4000) => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const absolute = value => validText(value) && !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root;
const within = (root, file) => file.startsWith(`${root}${path.sep}`);
const name = value => value.replace(/[\r\n\t]/g, " ").slice(0, 160);
const detailFields = ["plugins", "skills", "sessions", "mcpServers", "hooks", "subagents", "commands", "memory"];
const definitions = {
  AGENTS_MD: { name: "Instructions", warning: "Adds repository or profile instructions that future agent work can follow." },
  CONFIG: { name: "Settings", warning: "Imports supported settings. Review permissions and defaults after import." },
  SKILLS: { name: "Skills", field: "skills", warning: "Imports the whole detected skill group, including its files and executable scripts." },
  PLUGINS: { name: "Plugins", field: "plugins", warning: "Imports the whole detected plugin group. Plugins may require downloads and separate authorization." },
  MCP_SERVER_CONFIG: { name: "MCP connections", field: "mcpServers", warning: "Imports the whole detected connection group, which may include credentials, commands and environment values. Review access before use." },
  SUBAGENTS: { name: "Subagents", field: "subagents", warning: "Imports the whole detected subagent group and its instructions." },
  HOOKS: { name: "Hooks", field: "hooks", warning: "Imports the whole detected hook group. Hooks can execute commands; importing is not a grant of trust." },
  COMMANDS: { name: "Commands as skills", field: "commands", warning: "Imports the whole detected command group as skills. Review argument substitutions after import." },
  MEMORY: { name: "Project memories", field: "memory", warning: "Imports the whole detected memory group. Review it for private or project-specific context." },
  SESSIONS: { name: "Recent chat", field: "sessions", warning: "Copies this selected conversation. Unsupported source content, including images, may become native text markers. Its source is retained; no message is sent." },
};

function detailsFor(value, itemType) {
  if (value === null && ["AGENTS_MD", "CONFIG"].includes(itemType)) return null;
  if (!record(value) || Object.keys(value).some(key => !detailFields.includes(key))) fail("unknown or incomplete artifact details");
  const result = {};
  for (const field of detailFields) {
    if (field === "memory" && value[field] === undefined) continue;
    const entries = value[field];
    if (!Array.isArray(entries) || entries.length > (field === "sessions" ? 50 : 200)) fail("artifact detail limits exceeded or missing");
    const seen = new Set();
    result[field] = entries.map(entry => {
      let normalized;
      if (field === "memory") {
        if (!validText(entry) || !entry) fail("invalid memory metadata");
        normalized = entry;
      } else if (field === "sessions") {
        if (!record(entry) || !absolute(entry.path) || !absolute(entry.cwd) || entry.title !== null && !validText(entry.title)) fail("invalid conversation metadata");
        normalized = { path: entry.path, cwd: entry.cwd, title: entry.title };
      } else if (field === "plugins") {
        if (!record(entry) || !validText(entry.marketplaceName, 512) || !entry.marketplaceName || !Array.isArray(entry.pluginNames) || !entry.pluginNames.length || entry.pluginNames.length > 200 || entry.pluginNames.some(item => !validText(item, 512) || !item) || new Set(entry.pluginNames).size !== entry.pluginNames.length) fail("invalid plugin metadata");
        normalized = { marketplaceName: entry.marketplaceName, pluginNames: [...entry.pluginNames].sort() };
      } else {
        if (!record(entry) || !validText(entry.name, 512) || !entry.name) fail("invalid named artifact");
        normalized = { name: entry.name };
      }
      const identity = field === "sessions" ? normalized.path : field === "plugins" ? normalized.marketplaceName : field === "memory" ? normalized : normalized.name;
      if (seen.has(identity)) fail("ambiguous artifact identity");
      seen.add(identity); return normalized;
    }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  if (itemType !== "SESSIONS" && result.sessions.length) fail("conversation metadata outside a conversation group");
  return result;
}

// This is a review/selection boundary, NOT an authorization or filesystem
// boundary. The caller must verify owner/company/private profile, idle native
// session, source/target file state and confirmation before invoking import.
// A metadata revision cannot detect file-content changes or symlinks.
export function planCodexImport(detected, { source, workspace, home, includeHome = false }) {
  if (!sources.has(source)) fail("choose Claude Code or Cursor explicitly");
  if (!absolute(workspace) || !absolute(home) || typeof includeHome !== "boolean") fail("invalid worker scope");
  if (!record(detected) || !Array.isArray(detected.items) || detected.items.length > 40 || canonical(detected).length > 512000) fail("native catalog is incomplete or too large");
  const groups = [], choices = new Map(), identities = new Set(), sessionPaths = new Set();
  let excludedSessions = 0, excludedGroups = 0;
  for (const item of detected.items) {
    if (!record(item) || !Object.hasOwn(definitions, item.itemType) || !validText(item.description, 16000) || item.cwd !== null && item.cwd !== "" && !absolute(item.cwd)) fail("unknown or incomplete migration group");
    const cwd = item.cwd || null;
    if (cwd !== null && cwd !== workspace || cwd === null && !includeHome) { excludedGroups++; continue; }
    const identity = `${item.itemType}:${cwd ?? "profile"}`;
    if (identities.has(identity)) fail("duplicate migration group");
    identities.add(identity);
    const details = detailsFor(item.details, item.itemType), definition = definitions[item.itemType];
    const group = { itemType: item.itemType, description: item.description, cwd, details };
    groups.push(group);
    const scope = cwd ? "project" : "profile";
    if (item.itemType === "SESSIONS") {
      if (!includeHome) fail("conversation sources require the private worker profile");
      const allowedRoot = path.join(home, source === "claude-code" ? ".claude" : ".cursor");
      group.details.sessions = details.sessions.filter(session => {
        if (session.cwd !== workspace) { excludedSessions++; return false; }
        if (!within(allowedRoot, session.path)) fail("conversation source is outside the worker's source profile");
        return true;
      });
      for (const session of group.details.sessions) {
        if (sessionPaths.has(session.path)) fail("ambiguous conversation identity");
        sessionPaths.add(session.path);
        const id = hash([source, identity, session.path]);
        choices.set(id, { group, session, public: { id, itemType: item.itemType, name: name(session.title || "Untitled conversation"), scope: "project", count: 1, entries: [], warning: definition.warning } });
      }
    } else {
      const entries = definition.field ? details?.[definition.field] : null;
      if (definition.field && !entries?.length) fail("a detected artifact group has no reviewable entries");
      const names = !entries ? [] : definition.field === "plugins" ? entries.flatMap(entry => entry.pluginNames.map(plugin => name(`${entry.marketplaceName} / ${plugin}`))) : definition.field === "memory" ? entries.map(file => name(path.basename(file))) : entries.map(entry => name(entry.name));
      if (names.length > 200) fail("too many entries to review safely");
      const id = hash([source, identity]);
      choices.set(id, { group, public: { id, itemType: item.itemType, name: definition.name, scope, count: names.length || 1, entries: names, warning: definition.warning } });
    }
  }
  const items = [...choices.values()].map(choice => choice.public).sort((a, b) => a.scope.localeCompare(b.scope) || a.itemType.localeCompare(b.itemType) || a.id.localeCompare(b.id));
  const revision = hash({ source, workspace, home, includeHome, groups: groups.sort((a, b) => canonical(a).localeCompare(canonical(b))) });
  return {
    catalog: { source, revision, items: structuredClone(items), excludedSessions, excludedGroups },
    select(ids) {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > choices.size || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !choices.has(id))) fail("select entries from the current review");
      const selected = new Map();
      for (const id of ids) {
        const choice = choices.get(id);
        if (!selected.has(choice.group)) {
          const group = structuredClone(choice.group);
          if (choice.session) group.details.sessions = [];
          selected.set(choice.group, group);
        }
        if (choice.session) {
          // SESSIONS is the only native artifact type that honors detail-level
          // selection. Never submit an empty sessions group (bulk semantics).
          selected.get(choice.group).details.sessions.push(structuredClone(choice.session));
        }
      }
      return { migrationSource: source, migrationItems: [...selected.values()] };
    },
  };
}
