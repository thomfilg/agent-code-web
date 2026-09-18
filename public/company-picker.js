import { companyForChat, companyScope, normalizeCompanyScope } from "./company-scope.js";

export function knownCompanies(state, records = []) {
  if (Array.isArray(state?.companies)) return state.companies.map(company => company.id);
  return [...new Set([...(state?.chats || []).map(companyForChat), ...records.flatMap(record => [...companyScope(record).companies, record.login])].filter(Boolean))].sort();
}
export class CompanyPicker {
  constructor(root, onChange = () => {}, { compact = false, registeredOnly = false } = {}) {
    this.root = root; this.onChange = onChange;
    const fieldset = document.createElement("fieldset"); fieldset.className = "company-picker";
    const legend = document.createElement("legend"); legend.textContent = compact ? "Available to" : "Available companies";
    this.choices = document.createElement("div"); this.choices.className = "company-choices";
    const label = document.createElement("label"), caption = document.createElement("span"); caption.textContent = "Add companies";
    this.input = document.createElement("input"); this.input.placeholder = "12-apps, thomfilg"; this.input.autocomplete = "off";
    label.append(caption, this.input);
    const add = document.createElement("button"); add.type = "button"; add.className = "secondary-button"; add.textContent = "Add companies";
    this.error = document.createElement("p"); this.error.className = "form-error"; this.error.setAttribute("role", "alert");
    const addCompanies = () => {
      try {
        const values = this.input.value.split(/[\s,]+/).filter(Boolean);
        if (!values.length) return;
        this.scope = normalizeCompanyScope({ ...this.scope, companies: [...this.scope.companies, ...values] });
        this.known = [...new Set([...this.known, ...this.scope.companies])].sort();
        this.input.value = ""; this.error.textContent = ""; this.render(); this.onChange(this.value());
      } catch (error) { this.error.textContent = error.message; }
    };
    add.onclick = addCompanies;
    this.input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); addCompanies(); } };
    const help = document.createElement("p"); help.className = "muted";
    help.textContent = "Only checked companies can use this configuration. The first repository determines a chat’s company; secondary repositories never expand its access. No wildcard or global credentials.";
    if (registeredOnly) {
      const manage = document.createElement("button"); manage.type = "button"; manage.className = "secondary-button"; manage.textContent = "Manage companies";
      manage.onclick = () => { root.closest("dialog")?.close(); window.dispatchEvent(new Event("relay-open-companies")); };
      fieldset.append(legend, this.choices, manage);
    } else if (compact) {
      fieldset.classList.add("compact");
      this.extra = document.createElement("details"); this.extra.className = "company-picker-extra";
      const summary = document.createElement("summary"); summary.textContent = "Add a company";
      this.extra.append(summary, label, add, this.error);
      fieldset.append(legend, this.choices, this.extra);
    } else fieldset.append(legend, this.choices, label, add, this.error, help);
    root.replaceChildren(fieldset);
  }
  set(record = {}, known = []) {
    this.scope = companyScope(record); this.known = [...new Set([...known, ...this.scope.companies])].sort();
    this.input.value = ""; this.error.textContent = ""; this.render();
    if (this.extra) this.extra.open = !this.known.length;
  }
  value() { return { companies: [...this.scope.companies], allowUnassigned: this.scope.allowUnassigned }; }
  render() {
    this.choices.replaceChildren();
    for (const company of [...this.known, null]) {
      const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
      label.className = "checkbox-label"; input.type = "checkbox";
      input.checked = company ? this.scope.companies.includes(company) : this.scope.allowUnassigned;
      text.textContent = company || "Unassigned chats (no company)";
      input.onchange = () => {
        if (company) this.scope.companies = input.checked ? [...new Set([...this.scope.companies, company])].sort() : this.scope.companies.filter(value => value !== company);
        else this.scope.allowUnassigned = input.checked;
        this.onChange(this.value());
      };
      label.append(input, text); this.choices.append(label);
    }
  }
}
