const panels = ["diff", "tools", "preview", "browser", "side", "agents", "workspace"];

// One secondary workspace at a time: desktop column, narrow-screen overlay.
export function openSidePanel(name) {
  for (const kind of panels) {
    const panel = document.querySelector(`#${kind}-panel`);
    panel.hidden = kind !== name;
    if (kind !== name) panel.classList.remove("expanded");
    document.querySelector(".main").classList.toggle(`${kind}-open`, kind === name);
  }
  document.dispatchEvent(new CustomEvent("relay-panel-changed", { detail: { name } }));
}

export function closeSidePanel(name) {
  const panel = document.querySelector(`#${name}-panel`);
  const wasOpen = !panel.hidden;
  panel.hidden = true; panel.classList.remove("expanded");
  document.querySelector(".main").classList.remove(`${name}-open`);
  if (wasOpen) document.dispatchEvent(new CustomEvent("relay-panel-changed", { detail: { name: null } }));
  return wasOpen;
}
