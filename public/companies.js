const $ = selector => document.querySelector(selector);
const el = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };

export function companyOptions(select, companies, value = "", placeholder = "Select a company") {
  select.replaceChildren(new Option(placeholder, ""), ...companies.map(company => new Option(company.name === company.id ? company.name : `${company.name} · ${company.id}`, company.id)));
  select.value = companies.some(company => company.id === value) ? value : "";
}

export class CompaniesPage {
  constructor({ api, state, navigate, toast }) {
    Object.assign(this, { api, state, navigate, toast });
    $("#companies-button").onclick = () => navigate();
    window.addEventListener("relay-open-companies", () => navigate());
    $("#company-new").onclick = () => this.edit();
    $("#company-cancel").onclick = () => { $("#company-form").hidden = true; this.current = null; };
    $("#company-form").onsubmit = event => this.save(event);
  }
  async load() {
    $("#company-error").textContent = "";
    try {
      const [{ companies }, { connections: mcps }, github] = await Promise.all([this.api("/api/companies"), this.api("/api/mcps"), this.api("/api/github")]);
      this.state.companies = companies;
      $("#company-list").replaceChildren(...companies.map(company => {
        const card = el("section", "", "company-card"); card.dataset.companyId = company.id;
        const details = el("div", ""); details.append(el("h3", company.name), el("p", company.id, "muted"));
        const count = mcps.filter(connection => connection.companyId === company.id).length;
        const account = github.connections.find(connection => connection.companyId === company.id);
        details.append(el("p", `${count} MCP ${count === 1 ? "connection" : "connections"} · GitHub: ${account?.connected ? account.login : account ? "not connected" : "not assigned"}`, "muted"));
        const edit = el("button", "Edit", "secondary-button"); edit.type = "button"; edit.setAttribute("aria-label", `Edit ${company.name}`); edit.onclick = () => this.edit(company);
        card.append(details, edit); return card;
      }));
      $("#company-empty").hidden = Boolean(companies.length);
      window.dispatchEvent(new Event("relay-companies-changed"));
    } catch (error) { $("#company-error").textContent = error.message; }
  }
  edit(company = null) {
    if (this.saving) return;
    this.current = company; $("#company-form").hidden = false;
    $("#company-form-title").textContent = company ? `Edit ${company.name}` : "Add a company";
    $("#company-name").value = company?.name || "";
    $("#company-id").value = company?.id || ""; $("#company-id").readOnly = Boolean(company);
    $("#company-form-error").textContent = ""; $("#company-name").focus();
  }
  async save(event) {
    event.preventDefault(); if (this.saving) return; this.saving = true;
    const submit = event.submitter; if (submit) submit.disabled = true;
    const controls = [...$("#company-form").elements, $("#company-new")]; for (const control of controls) control.disabled = true;
    $("#company-form-error").textContent = "";
    try {
      const data = { id: $("#company-id").value, name: $("#company-name").value, revision: this.current?.revision };
      await this.api(this.current ? `/api/companies/${this.current.id}` : "/api/companies", { method: this.current ? "PATCH" : "POST", body: JSON.stringify(data) });
      this.current = null; $("#company-form").hidden = true; await this.load(); this.toast("Company saved");
    } catch (error) { $("#company-form-error").textContent = error.message; }
    finally { this.saving = false; for (const control of controls) control.disabled = false; }
  }
}
