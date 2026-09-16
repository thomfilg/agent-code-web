import { findPet, petActivity, PET_IMAGE_LIMIT } from "./pets.js";
import { PetSprite } from "./pet-sprite.js";
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text); element.type = "button"; element.onclick = action; return element; };
export class PetControls {
  constructor({ api, controls, getChat, notify, root }) {
    Object.assign(this, { api, controls, getChat, notify, root }); this.identityVersion = 0; this.loadVersion = 0; this.snapshot = { selected: null, pets: [] };
    this.openButton = button("", () => void this.open().catch(error => notify(error.message))); this.openButton.className = "pet-open";
    this.spriteRoot = node("span", undefined, "pet-art"); this.sprite = new PetSprite(this.spriteRoot); this.name = node("span"); this.state = node("small");
    const copy = node("span"); copy.append(this.name, this.state); this.openButton.append(this.spriteRoot, copy);
    const hide = button("×", () => void this.command("off").catch(error => notify(error.message))); hide.setAttribute("aria-label", "Hide pet");
    root.append(this.openButton, hide);
  }
  resetIdentity() { this.invalidatePanel?.(); this.identityVersion++; this.loadVersion++; this.snapshot = { selected: null, pets: [] }; this.render(); }
  accept(result) {
    if (this.snapshot.scope && this.snapshot.scope !== result.scope) { this.invalidatePanel?.(); this.identityVersion++; }
    this.snapshot = result; this.render();
  }
  async load() {
    const version = ++this.loadVersion, identity = this.identityVersion, result = await this.api("/api/pets");
    if (version !== this.loadVersion || identity !== this.identityVersion) return null;
    this.accept(result); return result;
  }
  render() {
    const chat = this.getChat(), permitted = chat && (!chat.ownerId || chat.ownerId === this.snapshot.account?.id);
    const pet = permitted ? this.snapshot.pets.find(pet => pet.id === this.snapshot.selected) : null;
    this.root.hidden = !pet; const activity = petActivity(permitted ? chat : null);
    this.name.textContent = pet?.name || ""; this.state.textContent = activity.label; this.root.dataset.activity = activity.id;
    this.openButton.setAttribute("aria-label", pet ? `${pet.name}: ${activity.label}. Choose pet` : "Choose pet");
    void this.sprite.show(pet, this.snapshot.scope, activity);
  }
  async mutate(path, method, input, snapshot) {
    const identity = this.identityVersion; this.loadVersion++;
    const result = await this.api(path, { method, body: JSON.stringify({ ...input, scope: snapshot.scope, revision: snapshot.revision }) });
    if (identity === this.identityVersion && result.scope === this.snapshot.scope && result.revision >= this.snapshot.revision) { this.loadVersion++; this.accept(result); }
    return result;
  }
  async command(argument = "") {
    if (!argument) return this.open();
    const identity = this.identityVersion, snapshot = await this.load();
    if (!snapshot || identity !== this.identityVersion) return false;
    const selected = ["off", "none", "hide", "hidden", "disable", "disabled"].includes(argument.toLowerCase()) ? null : findPet(snapshot.pets, argument).id;
    await this.mutate("/api/pets", "PATCH", { selected }, snapshot);
    this.notify?.(selected ? "Pet selection saved." : "Pet hidden."); return true;
  }
  async open() {
    this.disposePanel?.();
    const identity = this.identityVersion, panel = node("div", undefined, "pet-settings"), scope = node("p", "", "muted"), status = node("p", "Loading pets…", "muted"); status.setAttribute("role", "status");
    const choices = node("fieldset", undefined, "pet-choices"); choices.append(node("legend", "Choose a pet"));
    const art = node("div", undefined, "pet-art pet-preview"), sprite = new PetSprite(art), previewState = node("select"); previewState.setAttribute("aria-label", "Preview pet activity");
    for (const [value, text] of [["idle", "Still"], ["running", "Running"], ["input", "Needs input"], ["ready", "Ready"], ["blocked", "Blocked"]]) { const option = node("option", text); option.value = value; previewState.append(option); }
    const retry = button("Retry artwork", () => { const pet = snapshot?.pets.find(pet => pet.id === draft); if (current()) { void sprite.show(pet, snapshot?.scope, activity(), { retry: true }); if (this.snapshot.selected === pet?.id) void this.sprite.show(pet, this.snapshot.scope, petActivity(this.getChat()), { retry: true }); } });
    const preview = node("section", undefined, "pet-preview-column"); preview.setAttribute("aria-label", "Pet preview"); preview.append(art, previewState, retry);
    const grid = node("div", undefined, "pet-picker-grid"); grid.append(choices, preview);
    const upload = node("fieldset", undefined, "pet-upload"); upload.append(node("legend", "Add a custom pet"));
    const name = node("input"); name.maxLength = 64; name.setAttribute("aria-label", "Custom pet name"); name.placeholder = "Pet name";
    const image = node("input"); image.type = "file"; image.accept = "image/png,image/webp"; image.setAttribute("aria-label", "Pet sprite sheet");
    const manifest = node("input"); manifest.type = "file"; manifest.accept = ".json,application/json"; manifest.setAttribute("aria-label", "Optional pet manifest");
    const uploadButton = button("Upload pet", () => void uploadPet());
    upload.append(name, node("label", "PNG/WebP sprite sheet · up to 20 MiB"), image, node("label", "Optional pet.json or avatar.json (frame grid and animations)"), manifest, uploadButton);
    const save = button("Save pet", () => void persist()), remove = button("Delete custom pet", () => void deletePet()); save.className = "primary-button";
    const reload = button("Reload pets", () => { if (!dirty() || confirm("Discard the unsaved pet selection and reload?")) void refresh(); });
    const actions = node("div", undefined, "pet-actions"); actions.append(save, remove, reload);
    const scroll = node("div", undefined, "pet-scroll"), about = node("details");
    about.append(node("summary", "About pets and custom sheets"), node("p", "Optional web companion for the selected chat only. It does not change native profiles, send a prompt, read your browser activity or wake a worker. Animation pauses in hidden tabs and respects reduced motion. Built-in artwork is downloaded from OpenAI on demand, verified and cached by Relay.", "muted"), node("p", "Standard custom sheets are transparent 1536 × 1872 PNG/WebP, with eight columns and nine animation rows. A JSON manifest can describe another exact grid and animation frame indexes. Select files explicitly: Relay never scans your computer or follows a manifest path. Custom pets belong to your private Relay account (12 pets / 60 MiB). Upload adds to your library; Save applies the choice.", "muted"));
    scroll.append(node("p", "Choose a companion and Save. Off hides it. Closing cancels an unsaved selection.", "muted"), scope, grid, upload, about); panel.append(scroll, status, actions);
    this.controls.dialog("Pets", panel);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.identityVersion === identity;
    const observer = new MutationObserver(() => { if (!current()) dispose(); }); observer.observe(dialog, { attributes: true, attributeFilter: ["open"] }); observer.observe(panel.parentNode, { childList: true });
    const dispose = () => { observer.disconnect(); sprite.destroy(); if (this.disposePanel === dispose) this.disposePanel = null; };
    this.disposePanel = dispose;
    let snapshot = null, draft = null, pending = false;
    const dirty = () => snapshot && draft !== snapshot.selected;
    const activity = () => ({ ...({ running: { animation: "typing", label: "Running" }, input: { animation: "waiting", label: "Needs input" }, ready: { animation: "bounce", label: "Ready" }, blocked: { animation: "sad", label: "Blocked" } }[previewState.value] || { animation: "idle", label: "Still" }), animate: previewState.value !== "idle" });
    this.invalidatePanel = () => {
      if (!dialog.open || this.controls.dialogVersion !== version) return;
      status.textContent = "The Relay account changed. Close and reopen Pets to manage the current account's pets.";
      // Custom names, descriptions, chosen files and preview labels belong to
      // the old account too, not just the decoded bitmap and saved preference.
      snapshot = null; draft = null; choices.replaceChildren(); scope.textContent = "";
      name.value = image.value = manifest.value = ""; art.removeAttribute("aria-label");
      choices.disabled = upload.disabled = save.disabled = remove.disabled = reload.disabled = previewState.disabled = retry.disabled = true; dispose();
    };
    const render = () => {
      if (!current()) return;
      save.disabled = pending || !dirty(); choices.disabled = upload.disabled = pending || !snapshot;
      upload.disabled ||= !snapshot?.account; reload.disabled = pending; remove.hidden = !snapshot?.pets.some(pet => pet.id === draft && !pet.builtin); remove.disabled = pending;
      for (const input of choices.querySelectorAll("input")) input.checked = (input.value || null) === draft;
      const pet = snapshot?.pets.find(pet => pet.id === draft); art.setAttribute("aria-label", pet ? `${pet.name} preview` : "No pet");
      previewState.disabled = retry.disabled = !pet; void sprite.show(pet, snapshot?.scope, activity());
    };
    const populate = result => {
      snapshot = result; choices.replaceChildren(node("legend", "Choose a pet"));
      for (const pet of [{ id: "", name: "Off", description: "No companion" }, ...result.pets]) {
        const label = node("label"), input = node("input"), text = node("span", pet.name); input.type = "radio"; input.name = "pet-selection"; input.value = pet.id; input.setAttribute("aria-label", pet.name);
        input.onchange = () => { if (!current() || pending) return; draft = pet.id || null; status.textContent = dirty() ? "Unsaved pet selection. Save to apply." : "Saved pet selected."; render(); };
        text.append(node("small", pet.description, "muted")); label.append(input, text); choices.append(label);
      }
      scope.textContent = result.account ? `Saved for your Relay account: ${result.account.username}.` : "No private Relay account is signed in. The built-in selection is shared by this Relay installation. Sign in to keep your own selection and upload custom pets.";
    };
    previewState.onchange = render;
    const refresh = async () => {
      if (!current() || pending) return; pending = true; status.textContent = "Loading pets…"; render();
      try { const result = await this.load(); if (!current() || !result) return; populate(result); draft = result.selected; status.textContent = "Saved pets loaded. Select a pet to preview."; }
      catch (error) { if (current()) status.textContent = error.message; }
      finally { pending = false; render(); }
    };
    const change = async (path, method, input, message, after) => {
      pending = true; status.textContent = "Saving pets…"; render();
      try {
        const result = await this.mutate(path, method, input, snapshot);
        if (!current()) { this.notify?.("Pet library saved for the account shown in the original panel."); return; }
        if (this.snapshot.scope === result.scope && this.snapshot.revision > result.revision) {
          populate(this.snapshot); draft = this.snapshot.selected; status.textContent = "Pets changed again after this save. Showing the latest saved selection.";
        } else { populate(result); draft = result.selected; after?.(result); status.textContent = message; }
      } catch (error) { if (current()) status.textContent = `${error.message} Your selection is retained. Reload to check what was saved before retrying.`; else this.notify?.(error.message); }
      finally { pending = false; render(); }
    };
    const persist = () => { if (current() && !pending && dirty()) return change("/api/pets", "PATCH", { selected: draft }, "Pet selection saved and active."); };
    const uploadPet = async () => {
      if (!current() || pending || !snapshot?.account) return;
      const file = image.files[0], json = manifest.files[0];
      try {
        if (!file || file.size > PET_IMAGE_LIMIT) throw new Error("Choose a PNG/WebP sprite sheet no larger than 20 MiB.");
        if (json?.size > 64000) throw new Error("The optional manifest must be smaller than 64 KiB.");
        pending = true; status.textContent = "Checking sprite sheet…"; render();
        const bitmap = await createImageBitmap(file); bitmap.close();
        const definition = json ? JSON.parse(await json.text()) : undefined;
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Could not read the sprite sheet.")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
        if (!current()) return;
        await change("/api/pets/custom", "POST", { data, name: name.value.trim(), manifest: definition }, "Custom pet added. Preview it, then Save to use it.", result => { draft = result.pets.at(-1).id; name.value = image.value = manifest.value = ""; });
      } catch (error) { if (current()) status.textContent = error.message; }
      finally { pending = false; render(); }
    };
    const deletePet = () => {
      const pet = snapshot?.pets.find(pet => pet.id === draft && !pet.builtin);
      if (!current() || pending || !pet || !confirm(`Delete “${pet.name}” from your pet library? Its uploaded artwork will be removed. This cannot be undone; keep a copy if you want to upload it again.`)) return;
      return change(`/api/pets/custom/${pet.id}`, "DELETE", {}, "Custom pet and its uploaded artwork deleted.");
    };
    render(); await refresh(); return current() && Boolean(snapshot);
  }
}
