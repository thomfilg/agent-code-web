const rendered = new WeakMap();
const node = (tag, className, text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

// Keep draft answers and focus across unrelated live updates. Names are scoped
// so answering a side question cannot deselect the main agent's radio buttons.
export function renderAgentRequest(host, request, key, respond) {
  key = request ? key : null;
  if (rendered.has(host) && rendered.get(host) === key) return;
  rendered.set(host, key); host.replaceChildren(); host.hidden = !request;
  if (!request) return;
  host.append(node("h3", "", request.questions?.length ? `The agent has ${request.questions.length === 1 ? "a question" : `${request.questions.length} questions`}` : "Approval required"));
  host.append(node("p", "", request.prompt));
  if (request.command) host.append(node("code", "", request.command));
  const actions = node("div", "approval-actions");
  if (request.questions?.length) {
    const answers = Object.create(null);
    for (const [index, question] of request.questions.entries()) {
      const group = node("fieldset", "agent-question"); group.append(node("legend", "", question.question));
      const input = node(question.isSecret ? "input" : "textarea", "question-input");
      if (question.isSecret) { input.type = "password"; input.autocomplete = "off"; } else input.rows = 2;
      input.maxLength = 10000; input.setAttribute("aria-label", `${question.header || question.question} — your answer`); input.placeholder = question.header || "Answer";
      const options = node("div", "question-options");
      for (const option of question.options || []) {
        const label = node("label", "question-option"), radio = node("input", ""), copy = node("span", "");
        radio.type = question.multiSelect ? "checkbox" : "radio"; radio.name = `${key}-question-${index}`; radio.value = option.label;
        copy.append(node("strong", "", option.label)); if (option.description) copy.append(node("small", "", option.description));
        radio.onchange = () => {
          input.value = "";
          if (question.multiSelect) {
            const selected = [...options.querySelectorAll("input:checked")].map(option => option.value);
            if (selected.length) answers[question.id] = selected; else delete answers[question.id];
          } else if (radio.checked) answers[question.id] = option.label;
        };
        label.append(radio, copy); options.append(label);
      }
      input.addEventListener("input", () => { for (const radio of options.querySelectorAll("input")) radio.checked = false; if (input.value.trim()) answers[question.id] = input.value; else delete answers[question.id]; });
      group.append(options, input); host.append(group);
    }
    for (const [label, payload, style] of [["Send answers", () => ({ answers }), "approve"], ["Skip questions", () => ({ answers: {} }), "secondary-button"]]) {
      const button = node("button", style, label); button.type = "button"; button.onclick = () => respond(payload()); actions.append(button);
    }
  } else {
    for (const [label, decision, style] of [["Approve once", "accept", "approve"], ["For this session", "acceptForSession", "secondary-button"], ["Deny", "decline", "deny"]]) {
      if (request.availableDecisions && !request.availableDecisions.includes(decision)) continue;
      const button = node("button", style, label); button.type = "button"; button.onclick = () => respond({ decision }); actions.append(button);
    }
  }
  host.append(actions);
}
