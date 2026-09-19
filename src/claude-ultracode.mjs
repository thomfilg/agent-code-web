export const ULTRACODE_UNAVAILABLE = "Ultracode is not verified for this Claude account and model. Choose ordinary effort or refresh the model list.";
export const ULTRACODE_UNCONFIRMED = "Claude did not confirm Ultracode (xhigh plus workflows). No message was sent. Choose ordinary effort or retry with a supported model.";
const modelName = value => typeof value === "string" && /^[a-zA-Z0-9_.[\]-]{1,150}$/.test(value);
const appliedContract = snapshot => Boolean(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
  && snapshot.applied && typeof snapshot.applied === "object" && !Array.isArray(snapshot.applied)
  && typeof snapshot.applied.ultracode === "boolean" && modelName(snapshot.applied.model)
  && (snapshot.errors === undefined || Array.isArray(snapshot.errors) && snapshot.errors.length === 0));

// Only keep the native effort command's bounded hint and an applied-state
// capability receipt. Raw settings, policy/environment values and credentials
// must not escape this discovery process.
export function ultracodeDiscovery(initialized, snapshot) {
  const effort = Array.isArray(initialized?.commands) ? initialized.commands.find(command => command?.name === "effort") : null;
  const hint = typeof effort?.argumentHint === "string" && effort.argumentHint.length <= 1000 ? effort.argumentHint : "";
  const applied = snapshot?.applied;
  return {
    model: modelName(applied?.model) ? applied.model : null,
    advertised: /(?:^|[^a-zA-Z0-9_-])ultracode(?:$|[^a-zA-Z0-9_-])/.test(hint),
    control: appliedContract(snapshot),
  };
}

export function ultracodeForModel(model, discovery) {
  // Discovery starts without --model, so "default" refers to exactly this
  // observed account-default model. Other aliases cannot be guessed from it.
  const supported = Boolean(!model.disabled && model.efforts?.includes("xhigh") && discovery?.advertised && discovery.control
    && discovery.model && (model.id === "default" || model.id === discovery.model));
  return { supported, reason: supported ? "xhigh effort plus native workflow orchestration; verified again on the selected worker before sending." : ULTRACODE_UNAVAILABLE };
}

export function assertUltracodeApplied(snapshot, enabled) {
  const applied = snapshot?.applied;
  if (!appliedContract(snapshot) || applied.ultracode !== enabled
    || enabled && (applied.effort !== "xhigh" || !modelName(applied.model))) throw new Error(ULTRACODE_UNCONFIRMED);
}

export async function applyUltracode(control, enabled, check = () => {}, { allowUnsupported = false } = {}) {
  const request = (method, input) => control.request(method, input).catch(() => { throw new Error(ULTRACODE_UNCONFIRMED); });
  check();
  // Old CLIs may not implement this optional read. Only ordinary non-xhigh
  // without previous Ultracode may proceed without a native capability receipt.
  const before = allowUnsupported
    ? await control.request("get_settings", {}, { timeoutMs: 2000 }).catch(() => null)
    : await request("get_settings");
  check();
  if (!enabled && allowUnsupported && typeof before?.applied?.ultracode !== "boolean") return;
  if (!appliedContract(before)) throw new Error(ULTRACODE_UNCONFIRMED);
  await request("apply_flag_settings", { settings: { ultracode: enabled, ...(enabled ? { effortLevel: "xhigh" } : {}) } }); check();
  const after = await request("get_settings"); check();
  assertUltracodeApplied(after, enabled);
}
