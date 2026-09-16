import { DEFAULT_TITLE_ITEMS, validateTitleItems } from "../public/tab-title.js";
import { OrderedFieldPreferences } from "./ordered-field-preferences.mjs";
export class TabTitlePreferences extends OrderedFieldPreferences {
  constructor(records) { super(records, { kind: "tab-title", label: "Tab-title", defaults: DEFAULT_TITLE_ITEMS, validate: validateTitleItems }); }
}

// Keep only aggregate progress. Native plan explanations and step text never
// become title metadata or synthetic conversation messages.
export function planProgress(plan, sessionId, turnId) {
  if (!sessionId || !turnId || !Array.isArray(plan) || plan.length > 1000 || plan.some(item => !["pending", "inProgress", "completed"].includes(item?.status))) return null;
  return { agent: "codex", sessionId, turnId, total: plan.length,
    completed: plan.filter(item => item.status === "completed").length,
    inProgress: plan.filter(item => item.status === "inProgress").length, recordedAt: new Date().toISOString() };
}
