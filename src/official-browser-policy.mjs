import { z } from "zod";

const text = z.string().max(30000), target = z.string().min(1).max(2000);
const element = { target, element: z.string().max(1000).optional() };
const modifiers = z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).max(5).optional();
const website = z.string().max(4000).refine(value => {
  try { const url = new URL(value); return !url.username && !url.password && (url.href === "about:blank" || ["http:", "https:"].includes(url.protocol)); }
  catch { return false; }
});
const schemas = {
  browser_navigate: z.strictObject({ url: website }),
  browser_navigate_back: z.strictObject({}),
  browser_snapshot: z.strictObject({ target: target.optional(), depth: z.number().int().min(1).max(30).optional(), boxes: z.boolean().optional() }),
  browser_click: z.strictObject({ ...element, doubleClick: z.boolean().optional(), button: z.enum(["left", "right", "middle"]).optional(), modifiers }),
  browser_type: z.strictObject({ ...element, text, submit: z.boolean().optional(), slowly: z.boolean().optional() }),
  browser_press_key: z.strictObject({ key: z.string().min(1).max(100) }),
  browser_handle_dialog: z.strictObject({ accept: z.boolean(), promptText: z.string().max(4000).optional() }),
  browser_resize: z.strictObject({ width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) }),
  browser_wait_for: z.strictObject({ time: z.number().positive().max(10).optional(), text: text.optional(), textGone: text.optional() }).refine(value => value.time || value.text || value.textGone),
  browser_evaluate: z.strictObject({ function: text, target: target.optional(), element: z.string().max(1000).optional() }),
  browser_tabs: z.strictObject({ action: z.enum(["list", "new", "close", "select"]), index: z.number().int().min(0).max(11).optional(), url: website.optional() })
    .refine(value => value.action !== "select" || value.index !== undefined)
    .refine(value => !value.url || value.action === "new"),
};
export const browserPolicyFailure = code => Object.assign(new Error(`Browser MCP access denied (${code})`), { code });

export function allowedBrowserTools(mode) {
  if (!["guest", "personal"].includes(mode)) throw browserPolicyFailure("MODE_INVALID");
  return Object.keys(schemas).filter(name => mode === "guest" || name !== "browser_evaluate");
}

export function authorizeBrowserTool(mode, name, args = {}) {
  if (!allowedBrowserTools(mode).includes(name)) throw browserPolicyFailure("TOOL_DENIED");
  if (!args || typeof args !== "object" || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) throw browserPolicyFailure("ARGUMENTS_DENIED");
  let encoded;
  try { encoded = JSON.stringify(args); } catch { throw browserPolicyFailure("ARGUMENTS_DENIED"); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 64000) throw browserPolicyFailure("ARGUMENTS_DENIED");
  const parsed = schemas[name].safeParse(args);
  if (!parsed.success || mode === "personal" && name === "browser_tabs" && (parsed.data.action !== "list" || parsed.data.index !== undefined || parsed.data.url !== undefined)) throw browserPolicyFailure("ARGUMENTS_DENIED");
  return parsed.data;
}

export function browserToolCatalog(mode, tools) {
  const names = allowedBrowserTools(mode), selected = tools.filter(tool => names.includes(tool.name));
  if (selected.length !== names.length || new Set(selected.map(tool => tool.name)).size !== names.length) throw browserPolicyFailure("OFFICIAL_CATALOG_CHANGED");
  return selected.map(tool => {
    const inputSchema = z.toJSONSchema(schemas[tool.name], { unrepresentable: "any" });
    if (mode === "personal" && tool.name === "browser_tabs") {
      inputSchema.properties = { action: { type: "string", enum: ["list"] } };
      inputSchema.required = ["action"];
    }
    // Keep official names/descriptions, with the actually enforced narrower
    // Relay argument contract. Unknown/new official tools are never admitted.
    return { ...tool, inputSchema };
  });
}
