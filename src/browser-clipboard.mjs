// This fixed expression is the ONLY UI copy operation. Do not expose arbitrary
// evaluation or a worker/host clipboard API to the browser WebSocket.
export function selectedBrowserText() {
  let doc = document, element = doc.activeElement;
  for (let depth = 0; depth < 20; depth++) {
    if (element?.shadowRoot?.activeElement) { element = element.shadowRoot.activeElement; continue; }
    if (element?.tagName === "IFRAME" || element?.tagName === "FRAME") {
      try {
        if (!element.contentDocument) throw Error();
        doc = element.contentDocument; element = doc.activeElement; continue;
      } catch { throw Error("Copy from this embedded frame is unavailable. Open the page directly to copy its text."); }
    }
    break;
  }
  if (element?.type === "password") throw Error("Password fields cannot be copied from shared Chrome.");
  const root = element?.getRootNode();
  const text = typeof element?.selectionStart === "number"
    ? element.value.slice(element.selectionStart, element.selectionEnd)
    : String((root?.getSelection?.() || doc.getSelection())?.toString() || "");
  if (!text) throw Error("Select text in the remote page before copying.");
  if (text.length > 30000) throw Error("Copy at most 30,000 characters at a time.");
  return { text };
}

export const browserSelectionExpression = `(${selectedBrowserText.toString()})()`;
