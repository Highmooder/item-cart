// =====================================================================
// Ask Item cart AI — the search brain (no DOM, no network).
// =====================================================================
// WHAT: everything that happens AFTER the question is understood:
//   1. ruleParse()        a simple built-in reader, used if the AI is busy
//   2. normalizeFilters() double-checks the AI's filters before use
//   3. searchCatalog()    finds and ranks REAL products from the site's catalog
//   4. buildReply()       writes the answer text
// WHY (staying "in context"): the AI never sees or produces a product or a
// price. Results can only come from the catalog arrays passed in here, and
// every price shown later is read from that catalog again. The words the
// assistant writes are built from fixed templates in this file.
// FUTURE: vendor "area" field (Phase 2) and follow-up questions (Phase 3).
// =====================================================================

export const MAX_QUESTION_LENGTH = 200;
export const MAX_RESULTS = 4;
const OVER_BUDGET_RESULTS = 3;

// ---------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------
export const STOPWORDS = new Set(
  (
    "i a an the and or of to for from in on at near by with my me we you your is are am be can could would should " +
    "please pls need needs want wants looking look find get buy order show give any some something anything one ones " +
    "that this these those it its there here have has had do does just only vendor vendors seller sellers shop store " +
    "stores around within under below less than max maximum budget cheap cheapest cheaper lowest price prices priced " +
    "cost costs naira ngn up upto most best good top rated available sell selling sells where who which what how much " +
    "many over above more least about like also then so if but not no yes hi hello hey ok okay thanks thank"
  ).split(" ")
);

// Words that say nothing about WHERE (every vendor is "near UNIOSUN").
const PLACE_FILLER = new Set(
  (
    "uniosun osun state university school campus area side the a an of at in on near by around close to beside " +
    "opposite behind inside along off from within place vendor vendors"
  ).split(" ")
);

const SERVICE_WORDS = new Set(
  (
    "laundry washing wash repair repairs fix fixing cleaning braiding plaiting haircut barbing tailoring tailor " +
    "printing photocopy photocopying tutor tutoring delivery errand service services"
  ).split(" ")
);

// A few everyday synonyms so the basic search still understands the common asks.
const SYNONYMS = {
  bag: ["bag", "backpack", "handbag", "tote", "satchel"],
  shoe: ["shoe", "sneaker", "slipper", "sandal", "footwear"],
  phone: ["phone", "smartphone", "charger", "earbuds"],
  food: ["food", "rice", "meal", "snack"],
  drink: ["drink", "juice", "water", "zobo"],
  laundry: ["laundry", "washing"],
  cloth: ["cloth", "clothes", "shirt", "hoodie", "trouser", "wear"],
};

export function stem(word) {
  let w = String(word || "").toLowerCase().trim();
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

export function words(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'\-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function placeTokens(text) {
  return [...new Set(words(text).filter((w) => !PLACE_FILLER.has(w)).map(stem))].filter((w) => w.length > 1);
}

function wordStartsWith(haystackWords, stemmed) {
  return haystackWords.some((w) => w === stemmed || w.startsWith(stemmed) || stem(w) === stemmed);
}

// ---------------------------------------------------------------------
// 1. Basic reader (used when the AI is unavailable)
// ---------------------------------------------------------------------
function parseMoney(numberText, suffix) {
  let n = Number(String(numberText).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (suffix && /^(k|thousand)$/i.test(suffix)) n *= 1000;
  return Math.round(n);
}

export function ruleParse(message) {
  let text = String(message || "").slice(0, MAX_QUESTION_LENGTH).toLowerCase();
  text = text.replace(/[?!]+/g, " ");

  let maxPrice = null;
  let minPrice = null;

  const MONEY = "(?:\\u20a6|ngn|n)?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|thousand)?\\s*(?:naira|ngn)?";
  const maxRe = new RegExp(
    "(?:under|below|less than|within|max(?:imum)?(?: of)?|budget(?: of| is| around)?|not more than|up ?to|at most|around|about)\\s*" + MONEY,
    "i"
  );
  const minRe = new RegExp("(?:above|over|more than|at least|from|minimum(?: of)?)\\s*" + MONEY, "i");
  const looseRe = new RegExp("(?:\\u20a6|\\bngn\\s?|\\bn(?=\\d))\\s*(\\d[\\d,]*)\\s*(k|thousand)?|(\\d[\\d,]*)\\s*(k|thousand)?\\s*naira", "i");

  let m = text.match(maxRe);
  if (m) {
    maxPrice = parseMoney(m[1], m[2]);
    text = text.replace(m[0], " ");
  } else {
    m = text.match(looseRe);
    if (m) {
      maxPrice = parseMoney(m[1] || m[3], m[2] || m[4]);
      text = text.replace(m[0], " ");
    }
  }
  const mm = text.match(minRe);
  if (mm && /^(above|over|more than|at least|minimum)/i.test(mm[0])) {
    minPrice = parseMoney(mm[1], mm[2]);
    text = text.replace(mm[0], " ");
  }

  let sort = "best";
  if (/\b(cheapest|cheap|lowest price|least expensive|affordable)\b/.test(text)) sort = "price";
  else if (/\b(best rated|top rated|highest rated|best reviewed)\b/.test(text)) sort = "rating";

  // Place: whatever follows the LAST "near / at / around / in ..." phrase.
  let place = null;
  const clean = text.replace(/[,.;]+/g, " ").replace(/\s+/g, " ").trim();
  const prepositions = /\b(?:near|at|around|close to|beside|opposite|behind|inside|in|by)\s+(?:(?:the|a|my)\s+)?/g;
  let last = null;
  for (const hit of clean.matchAll(prepositions)) last = hit;
  let itemText = clean;
  if (last) {
    // The place phrase ends at a joining word ("... main gate and my ...").
    const tail = clean.slice(last.index + last[0].length).split(/\b(?:and|but|my|with|for|please|pls|thanks|thank)\b/)[0];
    const candidate = placeTokens(tail);
    if (candidate.length) {
      place = candidate.join(" ");
      itemText = clean.slice(0, last.index);
    }
  }

  const keywords = [];
  for (const w of words(itemText)) {
    if (STOPWORDS.has(w) || /^\d+$/.test(w) || w.length < 2) continue;
    const s = stem(w);
    for (const syn of SYNONYMS[s] || [s]) if (!keywords.includes(syn)) keywords.push(syn);
    if (keywords.length >= 8) break;
  }

  const wantsService = keywords.some((k) => SERVICE_WORDS.has(k));

  return { intent: "shopping", keywords, maxPrice, minPrice, place, vendor: null, sort, wantsService };
}

// ---------------------------------------------------------------------
// 2. Double-check filters before using them (never trust a reply blindly)
// ---------------------------------------------------------------------
function cleanPrice(value) {
  const n = typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n) : null;
}

export function normalizeFilters(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.intent !== "shopping" && raw.intent !== "off_topic") return null;

  const keywords = [];
  for (const k of Array.isArray(raw.keywords) ? raw.keywords : []) {
    const w = words(k).join(" ").slice(0, 24);
    if (w.length >= 2 && !keywords.includes(w)) keywords.push(w);
    if (keywords.length >= 8) break;
  }

  let maxPrice = cleanPrice(raw.maxPrice);
  let minPrice = cleanPrice(raw.minPrice);
  if (maxPrice !== null && minPrice !== null && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];

  const place = placeTokens(raw.place).join(" ").slice(0, 60) || null;
  const vendor = words(raw.vendor).join(" ").slice(0, 60) || null;

  return {
    intent: raw.intent,
    keywords,
    maxPrice,
    minPrice,
    place,
    vendor,
    sort: raw.sort === "price" || raw.sort === "rating" ? raw.sort : "best",
    wantsService: raw.wantsService === true,
  };
}

// Short lists the page sends to the AI so it can use the site's own words.
export function buildHints({ categories, vendors }) {
  const places = [...new Set((vendors || []).map((v) => String(v.location || "").trim()).filter(Boolean))].slice(0, 30);
  return { categories: (categories || []).map((c) => c.name).slice(0, 20), places };
}

// ---------------------------------------------------------------------
// 3. Search the real catalog
// ---------------------------------------------------------------------
// data = { products, vendors, categories }, isService(product) = the site's own rule.
export function placeScore(wanted, vendor) {
  if (!wanted.length) return 0;
  const have = new Set(placeTokens(vendor.location));
  const hit = wanted.filter((w) => have.has(w)).length;
  return hit / wanted.length;
}

function keywordScore(keywords, product, vendor, category) {
  if (!keywords.length) return 0;
  const name = words(product.name);
  const cat = words(category ? category.name : "");
  const desc = words(product.description);
  const store = words(vendor ? vendor.storeName : "");
  let best = 0;
  for (const k of keywords) {
    const s = stem(k);
    if (!s) continue;
    if (wordStartsWith(name, s)) best = Math.max(best, 3);
    else if (wordStartsWith(cat, s)) best = Math.max(best, 2);
    else if (wordStartsWith(desc, s) || wordStartsWith(store, s)) best = Math.max(best, 1);
  }
  return best;
}

export function searchCatalog(data, filters, isService = () => false) {
  const vendorById = new Map((data.vendors || []).map((v) => [v.id, v]));
  const categoryById = new Map((data.categories || []).map((c) => [c.id, c]));
  const wantedPlace = placeTokens(filters.place);
  const wantedVendor = words(filters.vendor).filter((w) => !STOPWORDS.has(w)).map(stem);
  const keywords = filters.keywords || [];

  // Stage 1: everything on the site that could answer the question.
  let candidates = [];
  for (const product of data.products || []) {
    if (product.availability === "unavailable") continue;
    const vendor = vendorById.get(product.vendorId);
    if (!vendor) continue; // only vendors that exist on the site
    const service = isService(product);
    if (service && !filters.wantsService) continue;

    const kw = keywordScore(keywords, product, vendor, categoryById.get(product.categoryId));
    if (keywords.length && kw === 0) continue;

    candidates.push({
      product,
      vendor,
      service,
      kw,
      place: placeScore(wantedPlace, vendor),
    });
  }

  // A named store narrows the list, but only if such a store exists.
  let vendorMissing = false;
  if (wantedVendor.length) {
    const named = candidates.filter((c) => {
      const store = words(c.vendor.storeName).map(stem);
      return wantedVendor.every((w) => store.some((s) => s.startsWith(w)));
    });
    if (named.length) candidates = named;
    else vendorMissing = true;
  }

  const inBudget = (c) =>
    (filters.maxPrice === null || c.product.price <= filters.maxPrice) &&
    (filters.minPrice === null || c.product.price >= filters.minPrice);
  const atPlace = (c) => c.place >= 0.5;

  const hasPlace = wantedPlace.length > 0;
  const budgetSet = filters.maxPrice !== null || filters.minPrice !== null;

  let shown = [];
  let note = null;
  let overBudget = false;

  const budgetOk = candidates.filter(inBudget);
  const placeAndBudget = budgetOk.filter(atPlace);

  if (hasPlace && placeAndBudget.length) {
    shown = placeAndBudget;
  } else if (budgetOk.length) {
    shown = budgetOk;
    if (hasPlace) note = candidates.some(atPlace) ? "placeOverBudget" : "placeMissing";
  } else if (candidates.length) {
    // Nothing fits the budget: show the closest options, clearly marked.
    overBudget = true;
    const pool = hasPlace && candidates.some(atPlace) ? candidates.filter(atPlace) : candidates;
    shown = [...pool].sort((a, b) => a.product.price - b.product.price).slice(0, OVER_BUDGET_RESULTS);
    if (hasPlace && !candidates.some(atPlace)) note = "placeMissing";
  }

  // Order the results.
  const cmpPrice = (a, b) => a.product.price - b.product.price;
  const cmpBest = (a, b) => b.place - a.place || b.kw - a.kw || cmpPrice(a, b);
  const cmpRating = (a, b) => (b.product.rating || 0) - (a.product.rating || 0) || cmpPrice(a, b);
  const order = overBudget ? cmpPrice : filters.sort === "price" ? cmpPrice : filters.sort === "rating" ? cmpRating : cmpBest;
  shown = [...shown].sort(order).slice(0, overBudget ? OVER_BUDGET_RESULTS : MAX_RESULTS);

  // Labels (short badges). Prices themselves are never copied into a label.
  const minPrice = shown.length ? Math.min(...shown.map((c) => c.product.price)) : 0;
  const topRating = shown.length ? Math.max(...shown.map((c) => c.product.rating || 0)) : 0;
  const results = shown.map((c) => {
    const labels = [];
    if (overBudget && filters.maxPrice !== null) labels.push("Over budget");
    if (!overBudget && shown.length > 1 && c.product.price === minPrice) labels.push("Cheapest");
    if (hasPlace && atPlace(c)) labels.push("Matches your location");
    if (filters.sort === "rating" && shown.length > 1 && (c.product.rating || 0) === topRating && topRating > 0) labels.push("Top rated");
    if (c.product.availability === "limited") labels.push("Limited stock");
    return { id: c.product.id, labels };
  });

  return { results, note, overBudget, vendorMissing, budgetSet, hasPlace, totalCandidates: candidates.length };
}

// ---------------------------------------------------------------------
// 4. Write the answer (fixed templates; numbers come from the shopper's own words)
// ---------------------------------------------------------------------
const naira = (n) => "\u20a6" + Number(n).toLocaleString("en-NG");

function itemLabel(filters) {
  const first = (filters.keywords || [])[0];
  return first ? `"${first}"` : "that";
}

function budgetPhrase(filters) {
  if (filters.maxPrice !== null && filters.minPrice !== null) return `between ${naira(filters.minPrice)} and ${naira(filters.maxPrice)}`;
  if (filters.maxPrice !== null) return `under ${naira(filters.maxPrice)}`;
  if (filters.minPrice !== null) return `above ${naira(filters.minPrice)}`;
  return "";
}

export const OFF_TOPIC_REPLY =
  "I can only help you find products, prices and vendors on Item cart. Try something like \"a bag under \u20a62,000\" or \"snacks near the student plaza\".";

export const NEED_MORE_REPLY = "Tell me what you're looking for, and your budget or where you'd like to collect it.";

export function buildReply(filters, search) {
  const { results, note, overBudget, vendorMissing, hasPlace } = search;
  const budget = budgetPhrase(filters);
  const place = filters.place ? `near ${filters.place}` : "";
  const parts = [];

  if (!results.length) {
    parts.push(`I couldn't find ${itemLabel(filters)} on Item cart right now.`);
    if (vendorMissing && filters.vendor) parts.push(`I also don't see a store called "${filters.vendor}".`);
    parts.push("Try another word, or browse the Marketplace.");
    return parts.join(" ");
  }

  if (overBudget) {
    parts.push(`Nothing for ${itemLabel(filters)} is ${budget} on Item cart right now. These are the closest options, so they're over your budget.`);
  } else {
    const count = results.length === 1 ? "1 option" : `${results.length} options`;
    parts.push(`I found ${count} for ${itemLabel(filters)}${budget ? " " + budget : ""}${hasPlace && !note ? " " + place : ""}.`);
  }

  if (note === "placeMissing") parts.push(`No vendor lists a location matching "${filters.place}" yet, so these are from elsewhere on campus. Check each vendor's location below.`);
  if (note === "placeOverBudget") parts.push(`Vendors ${place} don't have it within your budget, so these are from elsewhere on campus.`);
  if (vendorMissing && filters.vendor) parts.push(`I couldn't find a store called "${filters.vendor}", so I searched all stores.`);
  return parts.join(" ");
}

// One call that does the search AND writes the reply, used by the panel.
export function answer(data, filters, isService) {
  if (filters.intent === "off_topic") return { text: OFF_TOPIC_REPLY, results: [] };

  const hasSomething = filters.keywords.length || filters.maxPrice !== null || filters.minPrice !== null || filters.place || filters.vendor;
  if (!hasSomething) return { text: NEED_MORE_REPLY, results: [] };

  const search = searchCatalog(data, filters, isService);
  return { text: buildReply(filters, search), results: search.results };
}
