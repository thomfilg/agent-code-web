export function confirmDeleteChat(chat) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "delete-chat-confirmation";
    const card = document.createElement("div");
    card.className = "dialog-card compact";
    const title = document.createElement("h2");
    title.id = "delete-chat-confirmation-title";
    dialog.setAttribute("aria-labelledby", title.id);
    title.textContent = "Delete chat?";
    const description = document.createElement("p");
    description.textContent = `Permanently delete “${chat.title}”, its messages, and its workspace files? Any running agent will be stopped and its worker destroyed. This cannot be undone.`;
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-button";
    cancel.textContent = "Cancel";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button danger";
    remove.textContent = "Delete chat";
    actions.append(cancel, remove);
    card.append(title, description, actions);
    dialog.append(card);
    document.body.append(dialog);
    cancel.addEventListener("click", () => dialog.close("cancel"));
    remove.addEventListener("click", () => dialog.close("delete"));
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "delete");
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}
