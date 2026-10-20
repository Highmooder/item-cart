// =====================================================================
// Ask Item cart AI — the chat panel.
// =====================================================================
// LOADED: only when someone taps the launcher button (see askLauncher.js).
// FLOW for each message:
//   1. Ask the Edge Function what the shopper wants to DO (search, tweak the
//      last search, compare, pick one, ask about a listing). If it is slow,
//      busy or down, the basic reader in askDialog.js does it instead.
//   2. Work out the reply from the catalog ALREADY IN THE BROWSER
//      (askDialog.js / askSearch.js).
//   3. Draw it: text, product cards, a comparison table or a pick, plus
//      tappable quick replies.
// STAYING IN CONTEXT: the AI never supplies products, prices or details.
//   Every price, rating and difference on screen is read from the site's
//   catalog each time it is drawn. The only AI-assisted answer is "what does
//   the listing say?", and that shows the listing's own words (checked), or
//   says the listing doesn't say and offers a message to the vendor.
// STORAGE: the chat and its memory live in this browser for a few hours
//   (askStore.js). Nothing is written to Supabase.
// =====================================================================

import { loadCatalog } from "./catalog.js";
import { categories } from "../data/categories.js";
import { products } from "../data/products.js";
import { vendors, getVendorById } from "../data/vendors.js";
import { isServiceProduct, contactVendorUrl } from "./services.js";
import { escapeHtml, attrUrl } from "./escape.js";
import { formatNaira, withImageFallback, availabilityBadge } from "./render.js";
import { wireAddToCartButtons } from "./cart.js";
import { isBackendConfigured } from "./backend.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../data/supabaseConfig.js";
import { loadChatState, saveChat, clearChat, emptyChatState, CHAT_TTL_MS } from "./askStore.js";
import { MAX_QUESTION_LENGTH, buildHints } from "./askSearch.js";
import {
  blankIntent,
  compareView,
  evidenceInListing,
  listingMessage,
  listingText,
  localEvidence,
  normalizeUnderstanding,
  messageLines,
  ruleIntent,
  runTurn,
} from "./askDialog.js";

const AI_TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1000;
const SUGGESTIONS = ["A bag under \u20a62,000", "Snacks near the student plaza", "Cheapest laundry service"];
const GREETING = "Hi! Tell me what you need, your budget, and where you'd like to collect it. I'll search the vendors on Item cart for you, and help you choose if you can't decide.";

const state = {
  built: false,
  messages: [],
  ctx: emptyChatState().ctx,
  asking: null, // id of the product the shopper is asking about right now
  busy: false,
  lastAt: 0,
  onClose: null,
  stylesPromise: null,
};
const el = {};

// ---------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------
export async function openPanel({ onClose } = {}) {
  state.onClose = onClose || null;
  await loadStyles();
  build();

  const saved = loadChatState(); // also wipes a chat older than the time limit
  state.messages = saved.messages;
  state.ctx = saved.ctx;
  state.asking = null;
  await loadCatalog(); // prices on old messages are redrawn from the live catalog
  renderLog();

  el.panel.hidden = false;
  if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) el.input.focus();
}

function closePanel() {
  el.panel.hidden = true;
  if (state.onClose) state.onClose();
}

function loadStyles() {
  if (state.stylesPromise) return state.stylesPromise;
  state.stylesPromise = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("../../css/ask-item-cart.css", import.meta.url).href;
    link.onload = resolve;
    link.onerror = resolve; // the panel still works, just unstyled
    document.head.appendChild(link);
    setTimeout(resolve, 3000);
  });
  return state.stylesPromise;
}

function build() {
  if (state.built) return;
  state.built = true;

  const panel = document.createElement("section");
  panel.className = "ask-panel";
  panel.id = "ask-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "ask-title");
  panel.innerHTML = `
    <header class="ask-panel__head">
      <div>
        <h2 id="ask-title">Ask Item cart AI</h2>
        <p>Finds products and vendors on Item cart</p>
      </div>
      <div class="ask-panel__tools">
        <button type="button" class="ask-panel__btn" data-ask="clear">Clear</button>
        <button type="button" class="ask-panel__btn ask-panel__btn--icon" data-ask="close" aria-label="Close Ask Item cart AI">\u00d7</button>
      </div>
    </header>
    <div class="ask-panel__log" id="ask-log" aria-live="polite"></div>
    <div class="ask-panel__chips" id="ask-chips"></div>
    <div class="ask-focus" id="ask-focus" hidden></div>
    <form class="ask-panel__form" id="ask-form" autocomplete="off">
      <label class="visually-hidden" for="ask-input">Your question</label>
      <input id="ask-input" type="text" maxlength="${MAX_QUESTION_LENGTH}" enterkeyhint="send" placeholder="e.g. a bag under \u20a62,000" />
      <button type="submit" class="btn btn-primary" id="ask-send">Send</button>
    </form>
    <p class="ask-panel__fine">Only searches products on Item cart. Don't type personal details like phone numbers. This chat stays on your device for ${Math.round(CHAT_TTL_MS / 3600000)} hours.</p>
  `;
  document.body.appendChild(panel);

  el.panel = panel;
  el.log = panel.querySelector("#ask-log");
  el.chips = panel.querySelector("#ask-chips");
  el.focus = panel.querySelector("#ask-focus");
  el.form = panel.querySelector("#ask-form");
  el.input = panel.querySelector("#ask-input");
  el.send = panel.querySelector("#ask-send");

  wireAddToCartButtons(el.log);

  panel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-ask]");
    if (action) {
      const kind = action.dataset.ask;
      if (kind === "close") closePanel();
      if (kind === "clear") {
        clearChat();
        state.messages = [];
        state.ctx = emptyChatState().ctx;
        state.asking = null;
        renderLog();
      }
      if (kind === "suggest") ask(action.textContent);
      if (kind === "end-ask") {
        state.asking = null;
        renderFocus();
      }
      return;
    }
    const chipButton = event.target.closest("[data-chip]");
    if (chipButton) {
      const [mi, ci] = chipButton.dataset.chip.split(":").map(Number);
      return runChip(mi, ci);
    }
    const aboutButton = event.target.closest("[data-ask-about]");
    if (aboutButton) startAsking(aboutButton.dataset.askAbout);
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(el.input.value);
  });
}

// ---------------------------------------------------------------------
// Understanding the shopper
// ---------------------------------------------------------------------
function conversationContext() {
  const shown = (state.ctx.shown || [])
    .map((id, i) => ({ n: i + 1, name: (products.find((p) => p.id === id) || {}).name }))
    .filter((item) => item.name);
  const f = state.ctx.filters;
  return {
    shown,
    last: f ? { keywords: f.keywords, maxPrice: f.maxPrice, place: f.place } : null,
  };
}

async function postToAssistant(payload) {
  if (!isBackendConfigured) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/ask-runnit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null; // slow, offline or blocked: the caller falls back to the basic way
  } finally {
    clearTimeout(timer);
  }
}

async function understand(text, data) {
  const data2 = await postToAssistant({ message: text, ...buildHints({ categories, vendors }), context: conversationContext() });
  const rule = ruleIntent(text, state.ctx, data);

  if (data2 && data2.mode === "ai") {
    const u = normalizeUnderstanding(data2.filters);
    if (u) {
      // The AI found nothing to search for: trust the basic reader for the words and numbers.
      const empty = u.action === "search" && !u.keywords.length && u.maxPrice === null && u.minPrice === null && !u.place && !u.vendor;
      if (!empty) return { u, usedBasic: false };
    }
  }
  return { u: rule, usedBasic: true };
}

// "What does the listing say?" The AI may only point at a sentence in the listing; we check it.
async function answerFromListing(product, question) {
  const text = listingText(product);
  const result = await postToAssistant({ task: "answer", question, listing: { name: product.name, description: product.description || "" } });
  if (result && result.mode === "ai") {
    const evidence = result.found ? evidenceInListing(result.evidence, text) : null;
    return { evidence, source: "ai" };
  }
  return { evidence: localEvidence(question, text, product.name), source: "basic" };
}

// ---------------------------------------------------------------------
// Taking a turn
// ---------------------------------------------------------------------
// Stops double-taps. Typed questions also wait a second between sends (they can
// call the free AI); tapped quick replies don't need that wait because they never do.
function throttled({ gap = true } = {}) {
  if (state.busy) return true;
  if (gap && Date.now() - state.lastAt < MIN_GAP_MS) return true;
  state.busy = true;
  state.lastAt = Date.now();
  el.send.disabled = true;
  return false;
}

function finish(scroll = true) {
  state.busy = false;
  el.send.disabled = false;
  saveChat(state.messages, state.ctx);
  renderLog({ scrollToLatestReply: scroll });
  if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) el.input.focus();
}

// Runs one turn with an already-understood request and adds the reply to the chat.
async function takeTurn(u, usedBasic) {
  const data = { products, vendors, categories };
  state.ctx.focus = state.asking || state.ctx.focus;
  let turn = runTurn({ understood: u, ctx: state.ctx, data, isService: isServiceProduct });

  if (turn.needsAnswer) {
    const { product, question } = turn.needsAnswer;
    const answer = await answerFromListing(product, question);
    turn = { message: listingMessage(product, question, answer.evidence, answer.source), ctx: turn.ctx };
  }

  state.ctx = turn.ctx;
  const message = turn.message;
  if (message.kind === "search") {
    state.asking = null; // a new search ends "asking about a product"
    if (usedBasic && isBackendConfigured && message.results.length) message.text += " (Smart search is busy, so I used a simpler search.)";
  }
  state.messages.push(message);
}

async function ask(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_LENGTH);
  if (!text || throttled()) return;
  el.input.value = "";

  state.messages.push({ role: "user", text });
  renderLog({ typing: true });

  try {
    const catalog = await loadCatalog();
    if (!catalog.ok || !products.length) {
      state.messages.push({ role: "assistant", kind: "text", text: "The marketplace isn't loaded right now. Please refresh the page and try again.", results: [], chips: [] });
    } else if (state.asking) {
      // The shopper tapped "Ask about this": whatever they type next is the question.
      await takeTurn(blankIntent("ask", { question: text }), false);
    } else {
      const { u, usedBasic } = await understand(text, { products, vendors, categories });
      await takeTurn(u, usedBasic);
    }
  } catch (error) {
    console.error("Item cart: Ask Item cart AI failed.", error);
    state.messages.push({ role: "assistant", kind: "text", text: "Something went wrong. Please try again.", results: [], chips: [] });
  }
  finish();
}

// A tapped quick reply: no AI needed, the instruction is already inside the button.
async function runChip(messageIndex, chipIndex) {
  const message = state.messages[messageIndex];
  const chip = message && message.chips && message.chips[chipIndex];
  if (!chip) return;

  if (chip.act === "vendor") return handOffToVendor(chip.productId, chip.question);
  if (chip.act === "ask-about") return startAsking(chip.productId);
  if (throttled({ gap: false })) return;
  state.asking = null; // any other quick reply ends "asking about a product"

  state.messages.push({ role: "user", text: chip.label });
  renderLog({ typing: true });
  try {
    await loadCatalog();
    let u;
    if (chip.act === "compare") u = blankIntent("compare", { ids: chip.ids || [] });
    else if (chip.act === "choose") u = blankIntent("choose", { ids: chip.ids || [], criterion: chip.crit || "any" });
    else u = blankIntent("refine", { cheaper: true });
    await takeTurn(u, false);
  } catch (error) {
    console.error("Item cart: Ask Item cart AI failed.", error);
    state.messages.push({ role: "assistant", kind: "text", text: "Something went wrong. Please try again.", results: [], chips: [] });
  }
  finish();
}

// "Ask about this": the next thing typed is a question about this listing.
function startAsking(productId) {
  const product = products.find((p) => p.id === productId);
  if (!product) return;
  state.asking = product.id;
  state.ctx.focus = product.id;
  state.messages.push({
    role: "assistant",
    kind: "text",
    text: `What would you like to know about the ${product.name}? For example sizes, colours or what's included.`,
    results: [],
    chips: [],
  });
  saveChat(state.messages, state.ctx);
  renderLog({ scrollToLatestReply: true });
  el.input.focus();
}

// Opens a chat with the vendor about this product, with the question ready to send.
function handOffToVendor(productId, question) {
  const product = products.find((p) => p.id === productId);
  if (!product) return;
  try {
    sessionStorage.setItem("item_cart_ask_handoff", JSON.stringify({ productId: product.id, question: String(question || "").slice(0, 200), at: Date.now() }));
  } catch (_) {
    /* the chat still opens, just without the question filled in */
  }
  window.location.href = contactVendorUrl(product);
}

// ---------------------------------------------------------------------
// Drawing (everything below reads the LIVE catalog)
// ---------------------------------------------------------------------
const BADGE_CLASS = { "Over budget": "badge-danger", "Limited stock": "badge-accent" };
const productOf = (id) => products.find((p) => p.id === id);

function cardHtml(product, labels = []) {
  const vendor = getVendorById(product.vendorId);
  const url = `product.html?id=${encodeURIComponent(product.id)}`;
  const service = isServiceProduct(product);
  const badges = labels.map((l) => `<span class="badge ${BADGE_CLASS[l] || ""}">${escapeHtml(l)}</span>`).join("");
  const second = service
    ? `<a class="btn btn-outline btn-sm" href="${escapeHtml(contactVendorUrl(product))}">Contact Vendor</a>`
    : `<button type="button" class="btn btn-outline btn-sm" data-action="add-to-cart" data-product-id="${escapeHtml(product.id)}">Add to Cart</button>`;

  return `
    <article class="ask-card">
      <a class="ask-card__img" href="${url}" tabindex="-1" aria-hidden="true"><img src="${attrUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" /></a>
      <div class="ask-card__body">
        <a class="ask-card__name" href="${url}">${escapeHtml(product.name)}</a>
        <p class="ask-card__price">${formatNaira(product.price)} ${availabilityBadge(product.availability)}</p>
        <p class="ask-card__vendor">${escapeHtml(vendor ? vendor.storeName : "Item cart Vendor")}${vendor && vendor.location ? " \u00b7 " + escapeHtml(vendor.location) : ""}</p>
        ${badges ? `<p class="ask-card__labels">${badges}</p>` : ""}
        <div class="ask-card__actions">
          <a class="btn btn-primary btn-sm" href="${url}">View</a>${second}
          <button type="button" class="btn btn-outline btn-sm" data-ask-about="${escapeHtml(product.id)}" aria-label="Ask about ${escapeHtml(product.name)}">Ask</button>
        </div>
      </div>
    </article>`;
}

function cardsBlock(items) {
  const cards = items.filter((c) => c.product && c.product.availability !== "unavailable");
  if (!cards.length) return null;
  const list = document.createElement("div");
  list.className = "ask-cards";
  list.innerHTML = cards.map((c) => cardHtml(c.product, c.labels)).join("");
  list.querySelectorAll("img").forEach(withImageFallback);
  return list;
}

function compareTable(ids) {
  const view = compareView(ids, { products, vendors, categories }, state.ctx);
  if (!view) return null;
  const head = view.cols.map((c) => `<th scope="col"><a href="product.html?id=${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a></th>`).join("");
  const best = (id, which) => (view.best[which] === id ? ' class="is-best"' : "");
  const row = (label, cells) => `<tr><th scope="row">${label}</th>${cells}</tr>`;
  const wrap = document.createElement("div");
  wrap.className = "ask-compare";
  wrap.innerHTML = `
    <table>
      <thead><tr><td></td>${head}</tr></thead>
      <tbody>
        ${row("Price", view.cols.map((c) => `<td${best(c.id, "price")}>${formatNaira(c.price)}${view.best.price === c.id ? '<span class="visually-hidden"> (lowest)</span>' : ""}</td>`).join(""))}
        ${row("Rating", view.cols.map((c) => `<td${best(c.id, "rating")}>${c.rating ? "\u2605" + escapeHtml(c.rating) : "\u2014"}${view.best.rating === c.id ? '<span class="visually-hidden"> (highest)</span>' : ""}</td>`).join(""))}
        ${row("Vendor", view.cols.map((c) => `<td>${escapeHtml(c.vendorName)}</td>`).join(""))}
        ${row("Stock", view.cols.map((c) => `<td>${escapeHtml(c.stock)}</td>`).join(""))}
      </tbody>
    </table>`;
  return wrap;
}

function bubble(role, text) {
  const div = document.createElement("div");
  div.className = `ask-msg ask-msg--${role}`;
  div.textContent = text; // text only, never HTML
  return div;
}

// One assistant message as DOM (words and numbers come from the live catalog).
function assistantBlock(message) {
  const wrap = document.createElement("div");
  wrap.className = "ask-reply";

  if (message.kind === "compare") {
    const lines = messageLines(message, { products, vendors, categories }, state.ctx);
    const table = compareTable(message.ids || []);
    if (!table) {
      wrap.appendChild(bubble("bot", "Some of those products aren't available any more. Try searching again."));
    } else {
      wrap.appendChild(bubble("bot", ["Here's how they compare."].concat(lines).join(" ")));
      wrap.appendChild(table);
    }
  } else if (message.kind === "verdict") {
    const lines = messageLines(message, { products, vendors, categories }, state.ctx);
    if (!lines.length) {
      wrap.appendChild(bubble("bot", "Some of those products aren't available any more. Try searching again."));
    } else {
      wrap.appendChild(bubble("bot", lines.join(" ")));
      const card = cardsBlock([{ product: productOf((message.ids || [])[0]), labels: ["My pick"] }]);
      if (card) wrap.appendChild(card);
    }
  } else if (message.kind === "listing") {
    const product = productOf(message.productId);
    const name = product ? product.name : "this product";
    if (message.evidence) {
      wrap.appendChild(bubble("bot", `The listing for the ${name} says:`));
      const quote = document.createElement("blockquote");
      quote.className = "ask-quote";
      quote.textContent = `\u201c${message.evidence}\u201d`;
      wrap.appendChild(quote);
      wrap.appendChild(bubble("bot", message.source === "basic" ? "That's the closest line in the listing, so check it covers what you meant. Not sure? Ask the vendor." : "Not what you wanted to know? You can ask the vendor."));
    } else {
      wrap.appendChild(bubble("bot", `The listing for the ${name} doesn't say. Want to ask the vendor?`));
    }
  } else {
    wrap.appendChild(bubble("bot", message.text));
    const cards = cardsBlock((message.results || []).map((r) => ({ product: productOf(r.id), labels: r.labels })));
    if (cards) wrap.appendChild(cards);
  }
  return wrap;
}

function chipRow(messageIndex, chips) {
  const row = document.createElement("div");
  row.className = "ask-chiprow";
  chips.forEach((c, ci) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "filter-chip";
    b.dataset.chip = `${messageIndex}:${ci}`;
    b.textContent = c.label;
    row.appendChild(b);
  });
  return row;
}

function renderFocus() {
  const product = state.asking ? productOf(state.asking) : null;
  if (!product) {
    el.focus.hidden = true;
    el.focus.textContent = "";
    el.input.placeholder = "e.g. a bag under \u20a62,000";
    return;
  }
  el.focus.hidden = false;
  el.focus.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = `Asking about: ${product.name}`;
  const end = document.createElement("button");
  end.type = "button";
  end.className = "ask-focus__end";
  end.dataset.ask = "end-ask";
  end.setAttribute("aria-label", "Stop asking about this product");
  end.textContent = "\u00d7";
  el.focus.append(label, end);
  el.input.placeholder = "Type your question about it";
}

function renderLog({ typing = false, scrollToLatestReply = false } = {}) {
  el.log.innerHTML = "";
  el.log.appendChild(bubble("bot", GREETING));

  let lastBot = null;
  let lastBotIndex = -1;
  state.messages.forEach((message, index) => {
    if (message.role === "user") {
      el.log.appendChild(bubble("user", message.text));
      return;
    }
    const block = assistantBlock(message);
    el.log.appendChild(block);
    lastBot = block;
    lastBotIndex = index;
  });

  // Quick replies belong to the latest assistant message only.
  if (lastBot && !typing) {
    const chips = state.messages[lastBotIndex].chips || [];
    if (chips.length && lastBotIndex === state.messages.length - 1) lastBot.appendChild(chipRow(lastBotIndex, chips));
  }

  if (typing) {
    const t = bubble("bot", "Searching Item cart\u2026");
    t.classList.add("ask-msg--typing");
    el.log.appendChild(t);
  }

  el.chips.hidden = state.messages.length > 0;
  if (!state.messages.length) {
    el.chips.innerHTML = SUGGESTIONS.map((s) => `<button type="button" class="filter-chip" data-ask="suggest">${escapeHtml(s)}</button>`).join("");
  }

  renderFocus();
  if (scrollToLatestReply && lastBot) el.log.scrollTop = Math.max(0, lastBot.offsetTop - 8);
  else el.log.scrollTop = el.log.scrollHeight;
}
