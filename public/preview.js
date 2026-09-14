// Runs in an opaque-origin sandbox. Generated code never executes.
const source = decodeURIComponent(location.hash.slice(1));
document.body.innerHTML = DOMPurify.sanitize(source, {
  WHOLE_DOCUMENT: false, FORCE_BODY: true, ADD_TAGS: ["style"],
  FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "form", "input", "button", "textarea", "select", "a", "video", "audio"],
  FORBID_ATTR: ["srcset", "action", "formaction"],
});
