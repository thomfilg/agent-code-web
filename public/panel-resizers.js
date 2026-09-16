const storageKey = "relay-panel-layout-v1";
const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));

export function setupPanelResizers() {
  if (document.querySelector("#sidebar-resizer")) return;
  const sidebar = document.querySelector("#sidebar"), main = document.querySelector(".main");
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch {} };
  const make = (id, label, controls) => {
    const handle = document.createElement("div"); handle.id = id; handle.className = "panel-resizer"; handle.tabIndex = 0;
    handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical"); handle.setAttribute("aria-label", label); handle.setAttribute("aria-controls", controls);
    handle.title = `${label} · drag or use arrow keys · double-click to reset`; document.body.append(handle); return handle;
  };
  const sidebarHandle = make("sidebar-resizer", "Resize sidebar", "sidebar");
  const panelHandle = make("workspace-resizer", "Resize workspace panel", "conversation");
  const activePanel = () => [...document.querySelectorAll("#diff-panel, #tools-panel, #preview-panel, #browser-panel, #side-panel, #agents-panel, #workspace-panel")].find(p => !p.hidden && !p.classList.contains("expanded"));
  const apply = () => {
    if (Number.isFinite(saved.sidebar)) document.documentElement.style.setProperty("--sidebar-width", `${clamp(saved.sidebar, 200, Math.min(460, innerWidth - 640))}px`);
    if (Number.isFinite(saved.panel)) main.style.setProperty("--workspace-panel-width", `${clamp(saved.panel, 280, Math.max(280, main.clientWidth - 340))}px`);
    const desktop = innerWidth > 1000, panel = activePanel();
    sidebarHandle.hidden = !desktop;
    sidebarHandle.style.left = `${sidebar.getBoundingClientRect().right - 4}px`;
    sidebarHandle.setAttribute("aria-valuenow", Math.round(sidebar.getBoundingClientRect().width));
    sidebarHandle.setAttribute("aria-valuemin", "200"); sidebarHandle.setAttribute("aria-valuemax", String(Math.min(460, innerWidth - 640)));
    panelHandle.hidden = !desktop || !panel;
    if (panel) {
      const rect = panel.getBoundingClientRect(); panelHandle.style.left = `${rect.left - 4}px`; panelHandle.style.top = `${rect.top}px`;
      panelHandle.setAttribute("aria-controls", `conversation ${panel.id}`);
      panelHandle.setAttribute("aria-valuenow", Math.round(rect.width)); panelHandle.setAttribute("aria-valuemin", "280"); panelHandle.setAttribute("aria-valuemax", String(Math.max(280, main.clientWidth - 340)));
    }
  };
  const update = (kind, value) => { saved[kind] = value; apply(); };
  for (const [handle, kind] of [[sidebarHandle, "sidebar"], [panelHandle, "panel"]]) {
    const size = () => kind === "sidebar" ? sidebar.getBoundingClientRect().width : activePanel()?.getBoundingClientRect().width || 400;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
      const start = event.clientX, width = size(); document.body.classList.add("panel-resizing");
      const move = e => update(kind, width + (kind === "sidebar" ? 1 : -1) * (e.clientX - start));
      const finish = () => { document.body.classList.remove("panel-resizing"); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish); handle.removeEventListener("pointercancel", finish); persist(); };
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish);
    });
    handle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? Number(handle.getAttribute("aria-valuemin")) : event.key === "End" ? Number(handle.getAttribute("aria-valuemax")) : size() + (event.key === "ArrowRight" ? 20 : -20) * (kind === "sidebar" ? 1 : -1);
      update(kind, next); persist();
    });
    handle.addEventListener("dblclick", () => { delete saved[kind]; (kind === "sidebar" ? document.documentElement : main).style.removeProperty(kind === "sidebar" ? "--sidebar-width" : "--workspace-panel-width"); persist(); apply(); });
  }
  new ResizeObserver(apply).observe(main);
  new MutationObserver(apply).observe(main, { attributes: true, subtree: true, attributeFilter: ["class", "hidden"] });
  window.addEventListener("resize", apply); document.addEventListener("relay-panel-changed", apply); apply();
}
