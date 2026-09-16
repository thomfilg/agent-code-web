import { syntaxLanguage, syntaxTokens } from "./syntax-theme.js";
import "/vendor/syntax-runmode.js";
import "/vendor/syntax-simple.js";

self.onmessage = async ({ data: { id, source, language } }) => {
  try {
    const selected = syntaxLanguage(language);
    if (!selected) return self.postMessage({ id, tokens: null });
    for (const asset of selected.assets) await import(`/vendor/syntax-${asset}.js`);
    self.postMessage({ id, tokens: syntaxTokens(globalThis.CodeMirror, source, selected.mode) });
  } catch { self.postMessage({ id, error: "Syntax highlighting unavailable; the full source is still shown." }); }
};
