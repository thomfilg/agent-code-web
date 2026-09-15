const $ = selector => document.querySelector(selector);
const send = message => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error("Chrome extension did not respond. Reload it in chrome://extensions and try again.")), 15000);
  chrome.runtime.sendMessage(message).then(value => { clearTimeout(timer); value ? resolve(value) : reject(Error("Chrome extension is not ready. Try again.")); }, error => { clearTimeout(timer); reject(error); });
});
async function render() {
  const state = await send({ type: "status" });
  $("#pair-form").hidden = Boolean(state.name); $("#connection").hidden = !state.name;
  $("#connection-name").textContent = state.name || "";
  $("#access-status").textContent = state.sharing ? `Agent access ON · ${state.chatTitle}` : state.online ? "Connected · agent access OFF" : "Disconnected · agent access OFF";
  $("#revoke").disabled = !state.sharing; $("#reconnect").disabled = state.online;
}
$("#pair-form").onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const result = await send({ type: "pair", url: $("#relay-url").value, code: $("#pair-code").value.trim() }); if (result.error) throw Error(result.error); $("#pair-code").value = ""; $("#message").textContent = "Paired. Agent access is still off."; await render(); }
  catch (error) { $("#message").textContent = error.message; } finally { button.disabled = false; }
};
for (const type of ["revoke", "disconnect", "reconnect"]) $(`#${type}`).onclick = async () => { const result = await send({ type }); if (result?.error) $("#message").textContent = result.error; await render(); };
const refresh = () => render().catch(error => { $("#message").textContent = error.message; });
void refresh(); setInterval(refresh, 2000);
