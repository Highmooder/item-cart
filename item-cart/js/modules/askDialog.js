// =====================================================================
// Ask Item cart AI — the conversation brain (no DOM, no network).
// =====================================================================
// WHAT: turns "what the shopper meant" into the next reply: a new search, a
//   tweak to the last search ("cheaper"), a side-by-side comparison, a pick
//   ("which should I buy?") or an answer from a product's own listing.
// WHY (staying in context): the AI only ever says what the shopper WANTS to do
//   (an action plus a few filters). Everything the assistant then shows,
//   every price, rating, vendor and difference, is worked out HERE from the
//   site's own catalog. Replies are stored as instructions (kind + product ids)
//   and their words are written again from the live catalog each time they
//   are drawn, so an old chat can never show an old price.
// THE ONE EXCEPTION: answering a question about a listing. The AI may only
//   point to a sentence that really is in that listing (the server checks it),
//   and we show that sentence itself, quoted. If the listing doesn't say, the
//   shopper is offered a message to the vendor.
// FALLBACK: ruleIntent() understands the common follow-ups without any AI, so
//   everything still works when the free AI is busy.
// FUTURE: remember more preferences across chats (only if you ever store them).
// =====================================================================

import {
  stem,
  words,
  placeScore,
  placeTokens,
  STOPWORDS,
  MAX_RESULTS,
  OFF_TOPIC_REPLY,
  NEED_MORE_REPLY,
  ruleParse,
  normalizeFilters,
  searchCatalog,
  buildReply,
} from "./askSearch.js";

export const MAX_SHOWN = 6;
export const MAX_COMPARE = 3;
const ACTIONS = ["search", "refine", "compare", "choose", "ask", "chat", "off_topic"];
const CRITERIA = ["price", "rating", "location", "stock"];

const naira = (n) => "\u20a6" + Number(n).toLocaleString("en-NG");

export const emptyContext = () => ({ filters: null, shown: [], focus: null, cmp: [] });

// A "what the shopper wants" object with nothing filled in, for actions that come from a tapped button.
export const blankIntent = (action, extra = {}) => ({
  intent: "shopping",
  keywords: [],
  maxPrice: null,
  minPrice: null,
  place: null,
  vendor: null,
  sort: "best",
  wantsService: false,
  action,
  cheaper: false,
  refs: [],
  refNames: [],
  criterion: "any",
  question: null,
  ids: [],
  ...extra,
});

// ---------------------------------------------------------------------
// Checking what the AI (or the basic reader) says the shopper wants
// ---------------------------------------------------------------------
export function normalizeUnderstanding(raw) {
  const base = normalizeFilters(raw);
  if (!base) return null;

  let action = ACTIONS.includes(raw.action) ? raw.action : "search";
  if (base.intent === "off_topic") action = "off_topic";

  const refs = [];
  for (const n of Array.isArray(raw.refs) ? raw.refs : []) {
    if (Number.isInteger(n) && n >= 1 && n <= MAX_SHOWN && !refs.includes(n) && refs.length < 4) refs.push(n);
  }
  const refNames = (Array.isArray(raw.refNames) ? raw.refNames : [])
    .map((s) => (typeof s === "string" ? words(s).join(" ").slice(0, 40) : ""))
    .filter(Boolean)
    .slice(0, 3);
  const question = typeof raw.question === "string" ? raw.question.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";

  return {
    ...base,
    action,
    cheaper: raw.cheaper === true,
    refs,
    refNames,
    criterion: CRITERIA.includes(raw.criterion) ? raw.criterion : "any",
    question: question || null,
  };
}

// Applies a "change" (cheaper, other place...) on top of the previous search.
export function mergeFilters(prev, delta) {
  const base = prev || { intent: "shopping", keywords: [], maxPrice: null, minPrice: null, place: null, vendor: null, sort: "best", wantsService: false };
  const has = (v) => v !== null && v !== undefined;
  return {
    intent: "shopping",
    keywords: delta.keywords && delta.keywords.length ? delta.keywords : base.keywords,
    maxPrice: has(delta.maxPrice) ? delta.maxPrice : base.maxPrice,
    minPrice: has(delta.minPrice) ? delta.minPrice : base.minPrice,
    place: delta.place || base.place,
    vendor: delta.vendor || base.vendor,
    sort: delta.sort && delta.sort !== "best" ? delta.sort : base.sort,
    wantsService: Boolean(delta.wantsService || base.wantsService),
  };
}

// ---------------------------------------------------------------------
// Products the shopper might mean
// ---------------------------------------------------------------------
const byId = (data) => new Map((data.products || []).map((p) => [p.id, p]));
const live = (p) => p && p.availability !== "unavailable";

function significantTokens(text) {
  return words(text).filter((w) => !STOPWORDS.has(w) && w.length > 1).map(stem);
}

// The best product whose name contains ALL the words the shopper used.
function productByName(name, pool) {
  const wanted = significantTokens(name);
  if (!wanted.length) return null;
  let best = null;
  let bestScore = -1;
  for (const product of pool) {
    const have = words(product.name).map(stem);
    const matched = wanted.filter((tk) => have.some((h) => h === tk || h.startsWith(tk)));
    if (matched.length !== wanted.length) continue;
    const score = matched.length * 10 - (have.length - matched.length);
    if (score > bestScore) {
      best = product;
      bestScore = score;
    }
  }
  return best;
}

// Shown products first, then the rest of the catalog.
function poolFor(ctx, data) {
  const map = byId(data);
  const shown = (ctx.shown || []).map((id) => map.get(id)).filter(live);
  const rest = (data.products || []).filter((p) => live(p) && !shown.includes(p));
  return [...shown, ...rest];
}

export function resolveIds(understood, ctx, data) {
  const map = byId(data);
  const out = [];
  const add = (id) => {
    if (id && map.has(id) && live(map.get(id)) && !out.includes(id)) out.push(id);
  };
  for (const id of understood.ids || []) add(id);
  for (const n of understood.refs || []) add((ctx.shown || [])[n - 1]);
  const pool = poolFor(ctx, data);
  for (const name of understood.refNames || []) {
    const product = productByName(name, pool);
    if (product) add(product.id);
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------------
// The basic reader for follow-ups (used when the AI is unavailable)
// ---------------------------------------------------------------------
const CHOOSE_RE = /\b(pick (one )?for me|you (pick|choose|decide)|which (one )?should i (buy|get|choose|take|order|go for)|what should i (buy|get|choose|take|order)|which (one )?(do you|would you) (recommend|suggest|pick|choose)|your (pick|recommendation|choice)|recommend one|choose for me|decide for me)\b/;
const COMPARE_RE = /\b(compare|comparison|difference|differences|which (one )?is better|which is the better|better (one|choice|option)|can'?t (decide|choose)|cannot (decide|choose)|hard to (decide|choose)|help me (decide|choose)|versus|vs\.?)\b/;
const CHEAPER_RE = /\b(cheaper|less expensive|lower price|lower budget|more affordable|something cheap|anything cheap|cheap(er)? option)/;
const GREETING_RE = /^(hi|hello|hey|thanks?|thank you|ok(ay)?|cool|great|nice|good (morning|afternoon|evening))\b[\s!.]*$/;
const QUESTION_RE = /^(does|do|is|are|can|will|what|which|how|has|have|comes?|any)\b/;

function criterionFrom(t) {
  if (/\b(cheap|cheapest|price|pricing|budget|afford)/.test(t)) return "price";
  if (/\b(rating|rated|reviews?|quality|best)\b/.test(t)) return "rating";
  if (/\b(near|nearest|closest|close|location|distance)\b/.test(t)) return "location";
  if (/\b(available|in stock|stock)\b/.test(t)) return "stock";
  return "any";
}

const ORDINALS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };

function ordinalRefs(t) {
  const refs = [];
  const push = (n) => {
    if (n >= 1 && n <= MAX_SHOWN && !refs.includes(n)) refs.push(n);
  };
  let m;
  if ((m = t.match(/\bfirst (two|2)\b/))) [1, 2].forEach(push);
  else if ((m = t.match(/\bfirst (three|3)\b/))) [1, 2, 3].forEach(push);
  else if ((m = t.match(/\b([1-6])\s*(?:and|&|,|vs\.?|or)\s*([1-6])\b/))) {
    push(Number(m[1]));
    push(Number(m[2]));
  } else {
    for (const [word, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${word}\\b`).test(t)) push(n);
    const num = t.match(/(?:number|no\.?|#)\s*([1-6])\b/);
    if (num) push(Number(num[1]));
  }
  return refs;
}

// "jollof vs shawarma", "compare the jollof and the shawarma"
function vsNames(t) {
  const cleaned = t
    .replace(/\b(compare|comparison( of)?|difference(s)? between|between|which (one )?is better( between)?|i can'?t (decide|choose)( between)?|help me (decide|choose)( between)?)\b/g, " ")
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(/^(.+?)\s+(?:vs\.?|versus|or|and)\s+(.+)$/);
  if (!m) return [];
  const clip = (s) => words(s).filter((w) => !["the", "a", "an", "one", "this", "that"].includes(w)).slice(0, 4).join(" ");
  return [clip(m[1]), clip(m[2])].filter(Boolean);
}

// The product a question is about: the one whose NAME shares the most words with it
// ("the hoodie" -> Oversized Hoodie). Nothing is returned if it's unclear.
function mentionedProduct(t, pool) {
  const asked = words(t).filter((w) => !STOPWORDS.has(w) && w.length > 1).map(stem);
  let best = [];
  let bestScore = 0;
  for (const product of pool) {
    const have = words(product.name).map(stem);
    const hits = asked.filter((a) => have.some((h) => h === a || h.startsWith(a)));
    if (hits.length > bestScore) {
      best = [{ product, word: hits[0] }];
      bestScore = hits.length;
    } else if (hits.length === bestScore && hits.length > 0) {
      best.push({ product, word: hits[0] });
    }
  }
  return best.length === 1 ? { product: best[0].product, word: best[0].word } : null;
}

export function ruleIntent(text, ctx, data) {
  const t = String(text || "").toLowerCase().trim();
  const filters = ruleParse(text);
  const base = { ...filters, action: "search", cheaper: false, refs: [], refNames: [], criterion: "any", question: null };
  const hasShown = Boolean(ctx && ctx.shown && ctx.shown.length);

  if (GREETING_RE.test(t)) return { ...base, action: "chat" };
  if (CHOOSE_RE.test(t)) return { ...base, action: "choose", refs: ordinalRefs(t), criterion: criterionFrom(t) };
  if (COMPARE_RE.test(t)) return { ...base, action: "compare", refs: ordinalRefs(t), refNames: vsNames(t), criterion: criterionFrom(t) };

  // "jollof or shawarma?" with no other cue: compare only if both names are real products
  const names = vsNames(t);
  if (names.length === 2) {
    const pool = poolFor(ctx || emptyContext(), data);
    const a = productByName(names[0], pool);
    const b = productByName(names[1], pool);
    if (a && b && a.id !== b.id) return { ...base, action: "compare", refNames: names };
  }

  if (hasShown && CHEAPER_RE.test(t)) return { ...base, action: "refine", cheaper: true, keywords: [], wantsService: false };

  // A question that names a product ("does the hoodie come in black?")
  if (QUESTION_RE.test(t) || t.endsWith("?")) {
    const found = mentionedProduct(t, poolFor(ctx || emptyContext(), data));
    if (found) return { ...base, action: "ask", refNames: [found.word], question: String(text).slice(0, 200) };
  }

  // Only a budget / place / sort given after a search: tweak that search.
  const onlyTweaks = !filters.keywords.length && (filters.maxPrice !== null || filters.minPrice !== null || filters.place || filters.sort !== "best");
  if (ctx && ctx.filters && onlyTweaks) return { ...base, action: "refine" };

  return base;
}

// ---------------------------------------------------------------------
// Ranking and describing (all from the catalog)
// ---------------------------------------------------------------------
const stockRank = (p) => (p.availability === "in-stock" ? 0 : p.availability === "limited" ? 1 : 2);
const ratingOf = (p) => Number(p.rating) || 0;

function rank(list, criterion, wantedPlace, vendorOf) {
  const items = list.map((p) => ({ p, place: wantedPlace.length ? placeScore(wantedPlace, vendorOf(p)) : 0 }));
  const byPrice = (a, b) => a.p.price - b.p.price;
  const byRating = (a, b) => ratingOf(b.p) - ratingOf(a.p);
  let crit = criterion;
  if (crit === "location" && (!wantedPlace.length || new Set(items.map((i) => i.place)).size < 2)) crit = "any";

  if (crit === "price") return items.sort((a, b) => byPrice(a, b) || byRating(a, b));
  if (crit === "rating") return items.sort((a, b) => byRating(a, b) || byPrice(a, b));
  if (crit === "stock") return items.sort((a, b) => stockRank(a.p) - stockRank(b.p) || byPrice(a, b));
  if (crit === "location") return items.sort((a, b) => b.place - a.place || byPrice(a, b));

  // "any": a balance of price (lower is better), rating and stock, plus place when asked for
  const prices = items.map((i) => i.p.price);
  const ratings = items.map((i) => ratingOf(i.p));
  const span = (arr) => Math.max(...arr) - Math.min(...arr) || 1;
  const score = (i) =>
    0.45 * ((Math.max(...prices) - i.p.price) / span(prices)) +
    0.4 * ((ratingOf(i.p) - Math.min(...ratings)) / span(ratings)) +
    0.15 * (1 - stockRank(i.p) / 2) +
    (wantedPlace.length ? 0.25 * i.place : 0);
  return items.sort((a, b) => score(b) - score(a) || byPrice(a, b));
}

function viewHelpers(data) {
  const map = byId(data);
  const vendorMap = new Map((data.vendors || []).map((v) => [v.id, v]));
  const vendorOf = (p) => vendorMap.get(p.vendorId) || { storeName: "Item cart Vendor", location: "" };
  return { map, vendorOf };
}

const stockText = (p) => (p.availability === "in-stock" ? "In stock" : p.availability === "limited" ? "Limited stock" : "Unavailable");

export function compareView(ids, data, ctx) {
  const { map, vendorOf } = viewHelpers(data);
  const list = ids.map((id) => map.get(id)).filter(live).slice(0, MAX_COMPARE);
  if (list.length < 2) return null;

  const wanted = placeTokens(ctx && ctx.filters && ctx.filters.place);
  const cols = list.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    rating: ratingOf(p),
    vendorName: vendorOf(p).storeName,
    location: vendorOf(p).location || "",
    stock: stockText(p),
    placeScore: wanted.length ? placeScore(wanted, vendorOf(p)) : 0,
  }));

  const minPrice = Math.min(...cols.map((c) => c.price));
  const maxRating = Math.max(...cols.map((c) => c.rating));
  const best = {
    price: cols.filter((c) => c.price === minPrice).length === 1 ? cols.find((c) => c.price === minPrice).id : null,
    rating: maxRating > 0 && cols.filter((c) => c.rating === maxRating).length === 1 ? cols.find((c) => c.rating === maxRating).id : null,
  };

  const lines = [];
  const cheapest = cols.find((c) => c.price === minPrice);
  if (best.price) {
    const others = cols.filter((c) => c.id !== cheapest.id);
    lines.push(
      cols.length === 2
        ? `${cheapest.name} is ${naira(others[0].price - cheapest.price)} cheaper.`
        : `${cheapest.name} is the cheapest at ${naira(cheapest.price)}.`
    );
  } else if (cols.every((c) => c.price === cols[0].price)) {
    lines.push("They cost the same.");
  }
  if (best.rating) {
    const top = cols.find((c) => c.id === best.rating);
    lines.push(`${top.name} has the higher rating (\u2605${top.rating}).`);
  }
  if (cols.every((c) => c.vendorName === cols[0].vendorName)) lines.push(`All from ${cols[0].vendorName}.`);
  const limited = cols.filter((c) => c.stock !== "In stock");
  if (limited.length && limited.length < cols.length) lines.push(`${limited.map((c) => c.name).join(" and ")} ${limited.length > 1 ? "are" : "is"} limited stock.`);
  if (wanted.length) {
    const top = Math.max(...cols.map((c) => c.placeScore));
    const near = cols.filter((c) => c.placeScore === top);
    if (top > 0 && near.length < cols.length) lines.push(`${near.map((c) => c.name).join(" and ")} ${near.length > 1 ? "are" : "is"} closest to "${ctx.filters.place}".`);
  }
  return { cols, best, lines };
}

export function verdictView(ids, criterion, data, ctx) {
  const { map, vendorOf } = viewHelpers(data);
  const list = ids.map((id) => map.get(id)).filter(live).slice(0, 4);
  if (list.length < 2) return null;

  const wanted = placeTokens(ctx && ctx.filters && ctx.filters.place);
  const ranked = rank(list, criterion, wanted, vendorOf);
  const w = ranked[0].p;
  const runner = ranked[1].p;
  const lines = [`Go for the ${w.name}.`];

  if (criterion === "price") {
    lines.push(`It's the cheapest at ${naira(w.price)}${runner.price > w.price ? `, ${naira(runner.price - w.price)} less than the ${runner.name}` : ""}.`);
    const nicer = ranked.map((r) => r.p).find((p) => ratingOf(p) > ratingOf(w));
    if (nicer) lines.push(`Prefer a higher rating? The ${nicer.name} is \u2605${ratingOf(nicer)}.`);
  } else if (criterion === "rating") {
    lines.push(`It has the highest rating (\u2605${ratingOf(w)}${ratingOf(runner) < ratingOf(w) ? ` vs \u2605${ratingOf(runner)}` : ""}).`);
  } else if (criterion === "stock") {
    lines.push(`It's ${stockText(w).toLowerCase()}.`);
  } else if (criterion === "location" && wanted.length && ranked[0].place > ranked[1].place) {
    lines.push(`It's from ${vendorOf(w).storeName}, closest to "${ctx.filters.place}".`);
  } else {
    const why = [];
    const cheapest = Math.min(...list.map((p) => p.price));
    const topRating = Math.max(...list.map(ratingOf));
    if (w.price === cheapest && list.some((p) => p.price > w.price)) why.push(`the lowest price (${naira(w.price)})`);
    else why.push(`a fair price (${naira(w.price)})`);
    if (topRating > 0 && ratingOf(w) === topRating && list.some((p) => ratingOf(p) < topRating)) why.push(`the top rating (\u2605${ratingOf(w)})`);
    if (w.availability === "in-stock") why.push("in stock");
    lines.push(`It's the best all-round pick: ${why.join(", ")}.`);
  }
  return { winnerId: w.id, orderedIds: ranked.map((r) => r.p.id), lines };
}

// ---------------------------------------------------------------------
// Answering from a listing (no AI): find the sentence that mentions the question's words
// ---------------------------------------------------------------------
const QUESTION_WORDS = new Set(
  "does do is are can will what which how has have comes come it its this that the a an in on with for of to any there be i me my you your it's whats what's include includes included including contain contains get got".split(" ")
);

export function listingText(product, categoryName) {
  return [product.name, product.description].filter(Boolean).join(". ");
}

export function localEvidence(question, text, productName = "") {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return null;

  // British and American spellings should match ("colours" / "colors").
  const plain = (t) => String(t || "").replace(/colou?r/gi, "color");
  // The product's own name appears in its listing, so it must not count as "evidence".
  const nameWords = new Set(words(productName).map(stem));
  const wanted = words(plain(question)).filter((w) => !QUESTION_WORDS.has(w) && w.length > 1).map(stem).filter((w) => !nameWords.has(w));
  // A general question ("what's included?"): the listing's own description is the answer.
  if (!wanted.length) return source.slice(0, 240);

  const pieces = source.split(/(?<=[.!?;])\s+/).flatMap((s) => (s.length > 160 ? s.split(/,\s+/) : [s]));
  let best = null;
  let bestScore = 0;
  for (const piece of pieces) {
    const have = words(plain(piece)).map(stem);
    const score = wanted.filter((tk) => have.some((h) => h === tk || h.startsWith(tk))).length;
    if (score > bestScore) {
      best = piece;
      bestScore = score;
    }
  }
  return best ? best.trim().slice(0, 240) : null;
}

// Checks an "evidence" sentence really appears in the listing (case and spacing ignored).
export function evidenceInListing(evidence, text) {
  const squash = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const e = squash(evidence);
  if (e.length < 3) return null;
  const src = String(text || "").replace(/\s+/g, " ");
  const idx = squash(src).indexOf(e);
  if (idx === -1) return null;
  // The squashed and original strings share indexes unless trimming moved them; use a safe slice.
  const slice = src.slice(Math.max(0, idx), Math.max(0, idx) + e.length);
  return squash(slice) === e ? slice : evidence;
}

// ---------------------------------------------------------------------
// Chips (quick replies). Stored as small instructions, never as prices.
// ---------------------------------------------------------------------
const chip = (label, act, extra = {}) => ({ label, act, ...extra });

function searchChips(ids) {
  if (ids.length >= 2) {
    return [
      chip("Compare these", "compare", { ids: ids.slice(0, MAX_COMPARE) }),
      chip("Pick for me", "choose", { ids: ids.slice(0, 4), crit: "any" }),
      chip("Anything cheaper?", "cheaper"),
    ];
  }
  if (ids.length === 1) return [chip("Ask about this", "ask-about", { productId: ids[0] }), chip("Anything cheaper?", "cheaper")];
  return [];
}

function compareChips(ids) {
  return [
    chip("Lowest price", "choose", { ids, crit: "price" }),
    chip("Best rated", "choose", { ids, crit: "rating" }),
    chip("Pick for me", "choose", { ids, crit: "any" }),
  ];
}

function verdictChips(winnerId, ids) {
  return [chip("Ask about it", "ask-about", { productId: winnerId }), chip("Compare them", "compare", { ids: ids.slice(0, MAX_COMPARE) })];
}

export function listingMessage(product, question, evidence, source) {
  return {
    role: "assistant",
    kind: "listing",
    productId: product.id,
    question: String(question || "").slice(0, 200),
    evidence: evidence ? String(evidence).slice(0, 300) : null,
    source: source === "ai" ? "ai" : "basic",
    chips: [chip("Ask the vendor", "vendor", { productId: product.id, question: String(question || "").slice(0, 200) }), chip("Ask something else", "ask-about", { productId: product.id })],
  };
}

// ---------------------------------------------------------------------
// One turn of the conversation
// ---------------------------------------------------------------------
const text = (t, chips = []) => ({ role: "assistant", kind: "text", text: t, results: [], chips });

// Returns { message, ctx } or { needsAnswer: { product, question }, ctx }.
export function runTurn({ understood, ctx, data, isService }) {
  const next = { ...emptyContext(), ...ctx, shown: [...(ctx.shown || [])], cmp: [...(ctx.cmp || [])] };
  const map = byId(data);
  const u = understood;

  switch (u.action) {
    case "off_topic":
      return { message: text(OFF_TOPIC_REPLY), ctx: next };

    case "chat":
      return { message: text(next.filters ? "Anytime! Tell me if you'd like to look at something else, or I can help you choose between the options." : "Hi! Tell me what you need, your budget, and where you'd like to collect it."), ctx: next };

    case "compare": {
      let ids = resolveIds(u, next, data);
      if (ids.length < 2 && !(u.refs || []).length && !(u.refNames || []).length) ids = next.shown.filter((id) => live(map.get(id))).slice(0, MAX_COMPARE);
      ids = ids.slice(0, MAX_COMPARE);
      if (ids.length < 2) return { message: text("Which products should I compare? Search for something first, or tell me two product names, like \"jollof vs shawarma\"."), ctx: next };
      next.cmp = ids;
      return { message: { role: "assistant", kind: "compare", ids, chips: compareChips(ids) }, ctx: next };
    }

    case "choose": {
      let ids = resolveIds(u, next, data);
      if (ids.length === 1) return { message: text("That's the only option I have for that right now. Want to look at something else?"), ctx: next };
      if (ids.length < 2) ids = (next.cmp.length >= 2 ? next.cmp : next.shown).filter((id) => live(map.get(id))).slice(0, 4);
      if (ids.length < 2) {
        return { message: text(ids.length === 1 ? "That's the only option I have for that right now. Want to look at something else?" : "I need a few options to choose between. Tell me what you're looking for first."), ctx: next };
      }
      const criterion = CRITERIA.includes(u.criterion) ? u.criterion : "any";
      const view = verdictView(ids, criterion, data, next);
      if (!view) return { message: text("I couldn't compare those. Try searching again."), ctx: next };
      next.focus = view.winnerId;
      next.cmp = ids;
      return { message: { role: "assistant", kind: "verdict", ids: view.orderedIds, criterion, chips: verdictChips(view.winnerId, view.orderedIds) }, ctx: next };
    }

    case "ask": {
      const ids = resolveIds(u, next, data);
      const id = ids[0] || next.focus;
      const product = id ? map.get(id) : null;
      if (!product || !live(product)) {
        return { message: text("Which product do you mean? Tap \"Ask about this\" on one of the results, or tell me its name."), ctx: next };
      }
      next.focus = product.id;
      const question = (u.question || "").trim();
      // Price questions are answered by the live card (the price is read from the catalog).
      if (/\b(how much|price|cost|costs|expensive|pricey)\b/i.test(question)) {
        return { message: { role: "assistant", kind: "search", text: `Here's the ${product.name}. The price on the card is its price on Item cart right now.`, results: [{ id: product.id, labels: [] }], chips: [chip("Ask something else", "ask-about", { productId: product.id })] }, ctx: next };
      }
      if (!question) return { message: text(`What would you like to know about the ${product.name}? For example sizes, colours or what's included.`), ctx: next };
      return { needsAnswer: { product, question }, ctx: next };
    }

    case "refine":
    case "search":
    default: {
      let filters;
      let cheaperNote = false;
      if (u.action === "refine" && next.filters) {
        filters = mergeFilters(next.filters, u);
        if (u.cheaper) {
          cheaperNote = true;
          const shownPrices = next.shown.map((id) => map.get(id)).filter(live).map((p) => p.price);
          if (shownPrices.length) filters.maxPrice = Math.min(...shownPrices) - 1;
        }
      } else {
        filters = { intent: "shopping", keywords: u.keywords, maxPrice: u.maxPrice, minPrice: u.minPrice, place: u.place, vendor: u.vendor, sort: u.sort, wantsService: u.wantsService };
      }

      const something = filters.keywords.length || filters.maxPrice !== null || filters.minPrice !== null || filters.place || filters.vendor;
      if (!something) return { message: text(NEED_MORE_REPLY), ctx: next };

      const search = searchCatalog(data, filters, isService);
      const ids = search.results.map((r) => r.id);

      // "Cheaper" found nothing: keep the earlier search, so the shopper can carry on from it.
      if (cheaperNote && (!ids.length || search.overBudget)) {
        return { message: text("Those are already the cheapest options for that on Item cart right now. Want me to pick the best one for you?", next.shown.length >= 2 ? [chip("Pick for me", "choose", { ids: next.shown.slice(0, 4), crit: "any" })] : []), ctx: next };
      }

      next.filters = filters;
      next.focus = null;
      if (ids.length) next.shown = ids.slice(0, MAX_SHOWN);
      const reply = buildReply(filters, search);
      return { message: { role: "assistant", kind: "search", text: cheaperNote ? `Cheaper options: ${reply}` : reply, results: search.results, chips: searchChips(ids) }, ctx: next };
    }
  }
}

// Words for a message that is drawn from the LIVE catalog (compare / verdict).
export function messageLines(message, data, ctx) {
  if (message.kind === "compare") return (compareView(message.ids || [], data, ctx) || { lines: [] }).lines;
  if (message.kind === "verdict") return (verdictView(message.ids || [], message.criterion || "any", data, ctx) || { lines: [] }).lines;
  return [];
}
