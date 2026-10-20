// WHAT: the ONE place that makes text and links safe to put into HTML.
// WHY: product names, vendor details, customer notes and chat messages all
// come from people (and the database). If one contains "<" or a quote and
// is dropped into innerHTML as-is, it can break the page or run code.
// THE RULE: every value that comes from data goes through escapeHtml()
// (text and attributes) or attrUrl() (image/link addresses) before it is
// placed in a template. Numbers formatted by formatNaira()/toFixed() are
// already safe. Use encodeURIComponent() for values inside a URL's query.
// FUTURE: if templates ever grow, a tagged-template helper can apply this
// automatically — the rule stays the same.

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Only ordinary web addresses (and same-site paths) are allowed as image
// or link targets. Anything else (javascript:, data:, ...) becomes "".
export function safeUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? text : "";
  } catch (error) {
    return "";
  }
}

// safeUrl + escapeHtml, ready to drop into src="..." or href="..."
export function attrUrl(value) {
  return escapeHtml(safeUrl(value));
}
