// Relay's keyboard surface, not the remote Codex terminal keymap. Shared by
// persistence validation and browser dispatch so a saved binding really runs.
export const KEY_ACTIONS = [
  { context: "global", id: "new_chat", label: "New chat", defaults: ["ctrl-k", "meta-k"] },
  { context: "global", id: "focus_composer", label: "Focus composer", defaults: [] },
  { context: "global", id: "answer_request", label: "Focus agent question or approval", defaults: ["alt-up"] },
  { context: "composer", id: "send", label: "Send or queue message", defaults: ["enter"] },
  { context: "composer", id: "newline", label: "Insert a new line", defaults: ["shift-enter"] },
  { context: "composer", id: "history_previous", label: "Previous message at start of draft", defaults: ["up"] },
  { context: "composer", id: "history_next", label: "Next message at end of draft", defaults: ["down"] },
];
const aliases = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", pageup: "page-up", pagedown: "page-down", " ": "space", "/": "slash", "-": "minus", "=": "equal", ",": "comma", ".": "period", ";": "semicolon", "'": "quote", "`": "backquote", "[": "bracket-left", "]": "bracket-right", "\\": "backslash" };
const keys = new Set(["enter", "up", "down", "left", "right", "home", "end", "page-up", "page-down", ...Object.values(aliases)]);
const modifiers = ["ctrl", "meta", "alt", "shift"];
const reserved = /^(?:(?:ctrl|meta)-(?:[acvxyzlntrwqfhpso]|shift-(?:[ntwrijcp]|delete))|alt-(?:left|right|home|f4))$/;
export function normalizeBinding(input) {
  if (typeof input !== "string" || input.length > 64) throw new Error("Enter a shortcut such as ctrl-enter or alt-up");
  let remaining = input.trim().toLowerCase(); const selected = new Set();
  while (modifiers.some(modifier => remaining.startsWith(`${modifier}-`))) {
    const modifier = remaining.split("-")[0]; if (selected.has(modifier)) throw new Error("A shortcut cannot repeat a modifier");
    selected.add(modifier); remaining = remaining.slice(modifier.length + 1);
  }
  remaining = aliases[remaining] || remaining;
  if (!/^[a-z0-9]$/.test(remaining) && !keys.has(remaining)) throw new Error("Unsupported key. Escape, Tab and browser function keys keep their normal behavior.");
  const normalized = [...modifiers.filter(modifier => selected.has(modifier)), remaining].join("-");
  if (reserved.test(normalized)) throw new Error("That shortcut is reserved for the browser or standard text editing");
  if (!["enter", "up", "down", "left", "right", "home", "end", "page-up", "page-down"].includes(remaining) && !["ctrl", "alt", "meta"].some(modifier => selected.has(modifier))) throw new Error("Typing keys need Ctrl, Alt or Meta so normal text remains editable");
  return normalized;
}
export function validateBindings(value) {
  const object = item => item && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || Object.keys(value).some(context => !["global", "composer"].includes(context))) throw new Error("Choose a valid shortcut context");
  const output = {};
  for (const [context, entries] of Object.entries(value)) {
    if (!object(entries)) throw new Error("Choose valid shortcut actions"); output[context] = {};
    for (const [id, bindings] of Object.entries(entries)) {
      if (!KEY_ACTIONS.some(action => action.context === context && action.id === id) || !Array.isArray(bindings) || bindings.length > 4) throw new Error("Choose an action and up to four shortcuts; use an empty list to unbind it");
      const normalized = bindings.map(normalizeBinding);
      if (new Set(normalized).size !== normalized.length) throw new Error("Remove duplicate shortcuts from this action");
      if (context === "global" && normalized.some(binding => !/^(?:ctrl|alt|meta)-/.test(binding))) throw new Error("Global shortcuts require Ctrl, Alt or Meta");
      output[context][id] = normalized;
    }
  }
  for (const context of ["global", "composer"]) {
    const used = new Map();
    for (const action of KEY_ACTIONS.filter(item => item.context === context)) for (const binding of output[context]?.[action.id] ?? action.defaults) {
      if (used.has(binding)) throw new Error(`${binding} is already assigned to ${used.get(binding)} in ${context}`); used.set(binding, action.label);
    }
  }
  return output;
}
export function eventBinding(event) {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return null;
  let key = event.key?.toLowerCase();
  const shifted = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`", "{": "[", "}": "]", "|": "\\" };
  if (event.shiftKey) key = shifted[key] || key;
  key = aliases[key] || key;
  try { return normalizeBinding([event.ctrlKey && "ctrl", event.altKey && "alt", event.shiftKey && "shift", event.metaKey && "meta", key].filter(Boolean).join("-")); } catch { return null; }
}
export function boundAction(bindings, event, context) {
  const key = eventBinding(event); if (!key) return null;
  for (const scope of context === "composer" ? ["composer", "global"] : ["global"]) {
    const action = KEY_ACTIONS.find(item => item.context === scope && (bindings[scope]?.[item.id] ?? item.defaults).includes(key));
    if (action) return action.id;
  }
  return null;
}
