// Make the inherited company visible when an editor is opened from Settings.
export function companyContext(dialog, companies, companyId) {
  let label = dialog.querySelector(".company-settings-context");
  if (!label) { label = document.createElement("p"); label.className = "company-settings-context"; dialog.querySelector(".dialog-heading").after(label); }
  label.hidden = dialog.dataset.companyScoped !== "true";
  label.textContent = `Company: ${companies.find(company => company.id === companyId)?.name || companyId || "None selected"}`;
}
