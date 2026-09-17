import { DEFAULT_STATUS_ITEMS, validateStatusItems } from "../public/status-line.js";
import { OrderedFieldPreferences } from "./ordered-field-preferences.mjs";
export class StatusLinePreferences extends OrderedFieldPreferences {
  constructor(records) { super(records, { kind: "statusline", label: "Status-line", defaults: DEFAULT_STATUS_ITEMS, validate: validateStatusItems }); }
}
