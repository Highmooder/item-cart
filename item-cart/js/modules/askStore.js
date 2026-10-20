// =====================================================================
// Ask Item cart AI — where the chat is kept.
// =====================================================================
// WHAT: saves the conversation in THIS browser only, for a short time.
// WHY: nothing goes to Supabase, so chats use none of your free database
//      storage, and a customer's questions never leave their own device
//      (except the one sentence sent to the AI to understand it).
// HOW LONG: CHAT_TTL_MS after the LAST message (default 3 hours), then it
//      is wiped the next time the panel opens. Only the last
//      MAX_STORED_MESSAGES messages are kept.
// WHAT IS SAVED:
//   * the shopper's words and the assistant's plain text,
//   * product IDS (what was shown, compared or picked), never prices: the
//     comparison and pick texts are written again from the live catalog every
//     time, so an old chat can never show an old price,
//   * the "memory" of the conversation (the last search's filters, which
//     products were shown, which one the shopper is asking about),
//   * quick-reply buttons (small instructions) and, for a question about a
//     listing, the question and the listing sentence that answered it.
// FUTURE: a "keep my chat" option for signed-in customers, if you ever want it.
// =====================================================================

export const CHAT_KEY = "item_cart_ask_chat_v1";
export const CHAT_TTL_MS = 3 * 60 * 60 * 1000;
export const MAX_STORED_MESSAGES = 16;

function storage() {
  try {
    return window.localStorage;
  } catch (_) {
    return null; // private mode or blocked: the chat simply won't be remembered
  }
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const idList = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.slice(0, 80)).slice(0, max) : []);

function cleanChip(c) {
  if (!c || typeof c !== "object" || typeof c.label !== "string" || typeof c.act !== "string") return null;
  const out = { label: c.label.slice(0, 40), act: c.act.slice(0, 20) };
  if (typeof c.crit === "string") out.crit = c.crit.slice(0, 12);
  if (typeof c.productId === "string") out.productId = c.productId.slice(0, 80);
  if (typeof c.question === "string") out.question = c.question.slice(0, 200);
  if (Array.isArray(c.ids)) out.ids = idList(c.ids, 4);
  return out;
}

// Keep only what we expect, so a damaged or edited entry can't break the page.
function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  if (m.role !== "user" && m.role !== "assistant") return null;

  if (m.role === "user") {
    if (typeof m.text !== "string") return null;
    return { role: "user", text: m.text.slice(0, 600) };
  }

  const kind = ["text", "search", "compare", "verdict", "listing"].includes(m.kind) ? m.kind : "search";
  const out = { role: "assistant", kind, chips: (Array.isArray(m.chips) ? m.chips : []).map(cleanChip).filter(Boolean).slice(0, 4) };

  if (kind === "text" || kind === "search") {
    if (typeof m.text !== "string") return null;
    out.text = m.text.slice(0, 600);
    out.results = (Array.isArray(m.results) ? m.results : [])
      .filter((r) => r && typeof r.id === "string")
      .slice(0, 6)
      .map((r) => ({ id: r.id.slice(0, 80), labels: (Array.isArray(r.labels) ? r.labels : []).filter((l) => typeof l === "string").slice(0, 4) }));
  } else if (kind === "compare" || kind === "verdict") {
    out.ids = idList(m.ids, 4);
    if (kind === "verdict") out.criterion = ["price", "rating", "location", "stock", "any"].includes(m.criterion) ? m.criterion : "any";
  } else if (kind === "listing") {
    out.productId = str(m.productId, 80);
    out.question = str(m.question, 200);
    out.evidence = typeof m.evidence === "string" ? m.evidence.slice(0, 300) : null;
    out.source = m.source === "ai" ? "ai" : "basic";
  }
  return out;
}

function cleanFilters(f) {
  if (!f || typeof f !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000_000 ? Math.round(v) : null);
  return {
    intent: "shopping",
    keywords: (Array.isArray(f.keywords) ? f.keywords : []).filter((k) => typeof k === "string").map((k) => k.slice(0, 24)).slice(0, 8),
    maxPrice: num(f.maxPrice),
    minPrice: num(f.minPrice),
    place: str(f.place, 60) || null,
    vendor: str(f.vendor, 60) || null,
    sort: f.sort === "price" || f.sort === "rating" ? f.sort : "best",
    wantsService: f.wantsService === true,
  };
}

function cleanContext(c) {
  const base = c && typeof c === "object" ? c : {};
  return { filters: cleanFilters(base.filters), shown: idList(base.shown, 6), focus: str(base.focus, 80) || null, cmp: idList(base.cmp, 4) };
}

export const emptyChatState = () => ({ messages: [], ctx: cleanContext(null) });

export function loadChatState(now = Date.now()) {
  const store = storage();
  if (!store) return emptyChatState();
  try {
    const saved = JSON.parse(store.getItem(CHAT_KEY) || "null");
    if (!saved || typeof saved.savedAt !== "number" || now - saved.savedAt > CHAT_TTL_MS) {
      store.removeItem(CHAT_KEY);
      return emptyChatState();
    }
    return {
      messages: (Array.isArray(saved.messages) ? saved.messages : []).map(cleanMessage).filter(Boolean).slice(-MAX_STORED_MESSAGES),
      ctx: cleanContext(saved.ctx),
    };
  } catch (_) {
    try {
      store.removeItem(CHAT_KEY);
    } catch (__) { /* nothing more to do */ }
    return emptyChatState();
  }
}

// Kept for older callers: just the messages.
export function loadChat(now = Date.now()) {
  return loadChatState(now).messages;
}

export function saveChat(messages, ctx, now = Date.now()) {
  const store = storage();
  if (!store) return;
  try {
    const kept = messages.map(cleanMessage).filter(Boolean).slice(-MAX_STORED_MESSAGES);
    if (!kept.length) store.removeItem(CHAT_KEY);
    else store.setItem(CHAT_KEY, JSON.stringify({ savedAt: now, messages: kept, ctx: cleanContext(ctx) }));
  } catch (_) {
    /* storage full or blocked: skip quietly, the chat still works this visit */
  }
}

export function clearChat() {
  const store = storage();
  try {
    if (store) store.removeItem(CHAT_KEY);
  } catch (_) { /* ignore */ }
}
