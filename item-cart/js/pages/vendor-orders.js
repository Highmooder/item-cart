import { renderHeader, renderFooter } from "../modules/layout.js";
import { isBackendConfigured } from "../modules/backend.js";
import { getSession } from "../modules/auth.js";
import { getMyVendors } from "../modules/chat.js";
import { formatNaira } from "../modules/render.js";
import { escapeHtml as esc } from "../modules/escape.js";
import { listOrders, markOrderReady } from "../modules/vendorOrders.js";

// WHAT: the page where a vendor's team sees their PAID orders and taps Ready
// when one is packed. They can also message the customer about an order.
// WHO: a signed-in account that Item cart linked to a store (Admin → Vendors → Logins).
// THE RULE: the database only returns orders whose payment Item cart confirmed,
// and "Ready" is the only status a vendor can set. This page only asks and
// explains. It never shows the customer's phone number or email.
// FUTURE: email/push alerts for new orders, and a Completed step.

const REFRESH_MS = 30000;
const TO_PREPARE = ["pending", "confirmed", "processing"];

const state = {
  vendors: [],
  vendorId: null,
  orders: [],
  filter: "prepare",
  busy: false,
  loaded: false, // false until the first list arrives, so old orders don't toast as "new"
  seen: new Set(),
  timer: null,
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("account.html");
  renderFooter();

  if (!isBackendConfigured) return show("vo-setup");

  const session = await getSession();
  if (!session) {
    window.location.replace(`account.html?next=${encodeURIComponent("vendor-orders.html" + window.location.search)}`);
    return;
  }

  state.vendors = await getMyVendors();
  if (!state.vendors.length) return show("vo-notvendor");

  const wanted = new URLSearchParams(window.location.search).get("store");
  state.vendorId = state.vendors.some((v) => v.id === wanted) ? wanted : state.vendors[0].id;

  wire();
  show("vo-app");
  renderStores();
  renderLinks();
  await refresh();
  startAutoRefresh();
});

function show(id) {
  ["vo-loading", "vo-setup", "vo-notvendor", "vo-app"].forEach((v) => ($(v).style.display = v === id ? "block" : "none"));
}

// ---------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------
// quiet = true for the automatic refresh: it never shows an error banner
// for a brief connection drop, and never interrupts what the vendor is doing.
async function refresh({ quiet = false } = {}) {
  const storeId = state.vendorId;
  const result = await listOrders(storeId);
  if (storeId !== state.vendorId) return; // they switched stores meanwhile

  const banner = $("vo-error");
  if (!result.ok) {
    if (!quiet) {
      banner.textContent = result.error;
      banner.style.display = "block";
    }
    return;
  }
  banner.style.display = "none";

  const orders = result.data || [];
  const fresh = orders.filter((o) => !state.seen.has(o.id));
  orders.forEach((o) => state.seen.add(o.id));
  if (state.loaded && fresh.length) {
    toast(fresh.length === 1 ? `New paid order: ${fresh[0].id}` : `${fresh.length} new paid orders.`);
  }
  state.loaded = true;

  state.orders = orders;
  renderFilters();
  renderList();
}

function startAutoRefresh() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.hidden || state.busy || $("vo-confirm").open) return;
    refresh({ quiet: true });
  }, REFRESH_MS);

  // Coming back to the tab (or the phone) shows fresh orders straight away.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.busy && !$("vo-confirm").open) refresh({ quiet: true });
  });
}

// ---------------------------------------------------------------------
// What the vendor should see for one order
// ---------------------------------------------------------------------
function groupOf(order) {
  if (TO_PREPARE.includes(order.orderStatus)) return "prepare";
  return order.orderStatus; // ready | completed | cancelled
}

function statusBadge(order) {
  switch (groupOf(order)) {
    case "prepare":
      return ["To prepare", "badge-accent"];
    case "ready":
      return ["Ready", "badge-verified"];
    case "completed":
      return ["Completed", "badge-verified"];
    case "cancelled":
      return ["Cancelled", "badge-danger"];
    default:
      return [order.orderStatus, "badge-outline"];
  }
}

function matchesFilter(order) {
  return state.filter === "all" || groupOf(order) === state.filter;
}

function when(iso) {
  return new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function renderStores() {
  const el = $("vo-stores");
  if (state.vendors.length < 2) {
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  el.innerHTML = state.vendors
    .map((v) => `<button type="button" class="filter-chip ${v.id === state.vendorId ? "is-active" : ""}" data-store="${esc(v.id)}" aria-pressed="${v.id === state.vendorId}">${esc(v.storeName)}</button>`)
    .join("");
}

// Quick links to the vendor's other pages for this same store.
function renderLinks() {
  const id = encodeURIComponent(state.vendorId);
  $("vo-links").innerHTML = `<a href="messages.html?as=${id}">Inbox</a><a href="vendor-products.html?store=${id}">Manage products</a>`;
}

function renderFilters() {
  const count = (g) => state.orders.filter((o) => groupOf(o) === g).length;
  const labels = [
    ["prepare", "To prepare", count("prepare")],
    ["ready", "Ready", count("ready")],
    ["completed", "Completed", count("completed")],
    ["all", "All", state.orders.length],
  ];
  $("vo-filters").innerHTML = labels
    .map(([key, label, n]) => `<button type="button" class="filter-chip ${state.filter === key ? "is-active" : ""}" data-filter="${key}" aria-pressed="${state.filter === key}">${label} (${n})</button>`)
    .join("");
}

function emptyMessage() {
  if (!state.orders.length) return ["No paid orders yet", "When a customer orders from your store and Item cart confirms their payment, the order appears here."];
  switch (state.filter) {
    case "prepare":
      return ["Nothing to prepare", "You're all caught up. New paid orders show up here."];
    case "ready":
      return ["Nothing marked Ready", "Orders you mark Ready are listed here until they're completed."];
    case "completed":
      return ["No completed orders", "Orders Item cart marks as completed are listed here."];
    default:
      return ["Nothing here", "No orders match this filter."];
  }
}

function messageLink(order) {
  const store = encodeURIComponent(state.vendorId);
  return order.conversationId
    ? `messages.html?c=${encodeURIComponent(order.conversationId)}&as=${store}`
    : `messages.html?order=${encodeURIComponent(order.id)}&as=${store}`;
}

function renderList() {
  let list = state.orders.filter(matchesFilter);
  // Oldest first for what still needs doing (first come, first served);
  // newest first everywhere else.
  list = [...list].sort((a, b) => (state.filter === "prepare" ? new Date(a.createdAt) - new Date(b.createdAt) : new Date(b.createdAt) - new Date(a.createdAt)));

  $("vo-count").textContent = `${list.length} order${list.length === 1 ? "" : "s"}`;
  const el = $("vo-list");

  if (!list.length) {
    const [title, text] = emptyMessage();
    el.innerHTML = `<div class="empty-state"><h3>${esc(title)}</h3><p style="margin-inline:auto">${esc(text)}</p></div>`;
    return;
  }

  el.innerHTML = list.map(renderOrder).join("");
}

function renderOrder(o) {
  const group = groupOf(o);
  const [statusText, statusClass] = statusBadge(o);
  const open = group === "prepare" || group === "ready";
  const items = (o.items || [])
    .map((i) => `<li><span>${esc(i.quantity)} × ${esc(i.name)}</span><span>${formatNaira(i.price * i.quantity)}</span></li>`)
    .join("");

  const where =
    o.deliveryMethod === "delivery"
      ? `<p class="vo-order__where"><strong>Deliver to:</strong> ${esc(o.location || "Location not given. Message the customer.")}</p>`
      : `<p class="vo-order__where"><strong>Pickup:</strong> the customer collects this from you.</p>`;

  const note = o.note ? `<p class="vp-item__note vp-item__note--warn"><strong>Customer note:</strong> ${esc(o.note)}</p>` : "";
  const dispute = o.disputeStatus === "open" ? `<p class="vp-item__note vp-item__note--bad">There is a dispute on this order. Item cart will contact you.</p>` : "";
  const guest = open && !o.canMessage ? `<p class="vo-order__guest">This customer ordered as a guest, so in-site chat isn't available. Contact Item cart if you can't reach them.</p>` : "";

  const payout = o.payout !== o.subtotal ? `<div><span>Your payout</span><strong>${formatNaira(o.payout)}</strong></div>` : "";

  const actions = [];
  if (group === "prepare") actions.push(`<button type="button" class="btn btn-primary btn-sm" data-act="ready" data-id="${esc(o.id)}">Ready</button>`);
  if (open && o.canMessage) actions.push(`<a class="btn btn-outline btn-sm" href="${esc(messageLink(o))}">Message customer</a>`);

  return `
    <article class="vo-order" data-order="${esc(o.id)}">
      <div class="vo-order__head">
        <h3>${esc(o.id)}</h3>
        <span class="badge ${statusClass}">${esc(statusText)}</span>
        <span class="badge badge-outline">${o.deliveryMethod === "delivery" ? "Delivery" : "Pickup"}</span>
        <span class="vo-order__time">${esc(when(o.createdAt))}</span>
      </div>
      <p class="vo-order__customer">${esc(o.customerName)}</p>
      <ul class="vo-items">${items}</ul>
      <div class="vo-order__total"><div><span>Order total</span><strong>${formatNaira(o.subtotal)}</strong></div>${payout}</div>
      ${where}
      ${note}
      ${dispute}
      ${guest}
      ${actions.length ? `<div class="vo-order__actions">${actions.join("")}</div>` : ""}
    </article>`;
}

// ---------------------------------------------------------------------
// Toast and confirm
// ---------------------------------------------------------------------
let toastTimer;
function toast(message, isError = false) {
  const el = $("vo-toast");
  el.textContent = message;
  el.className = "vp-toast" + (isError ? " vp-toast--error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 5000);
}

function confirmDialog({ title, body, okLabel }) {
  return new Promise((resolve) => {
    const dlg = $("vo-confirm");
    $("vo-confirm-title").textContent = title;
    $("vo-confirm-body").textContent = body;
    $("vo-confirm-ok").textContent = okLabel;
    let confirmed = false;
    $("vo-confirm-ok").onclick = () => {
      confirmed = true;
      dlg.close();
    };
    $("vo-confirm-cancel").onclick = () => dlg.close();
    dlg.onclose = () => resolve(confirmed);
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
async function onReady(order) {
  const ok = await confirmDialog({
    title: `Mark ${order.id} as Ready?`,
    body: "Do this once the order is packed and ready to hand over. The customer will see it as Ready on their order. If you tap it by mistake, contact Item cart to change it.",
    okLabel: "Mark Ready",
  });
  if (!ok || state.busy) return;

  state.busy = true;
  try {
    const result = await markOrderReady(order.id);
    if (!result.ok) {
      toast(result.error, true);
    } else {
      toast(`${order.id} is marked Ready.`);
    }
    // Refresh either way: after an error the list may have changed (for
    // example Item cart cancelled the order), and the vendor should see that.
    await refresh();
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function wire() {
  $("vo-stores").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-store]");
    if (!btn || btn.dataset.store === state.vendorId) return;
    state.vendorId = btn.dataset.store;
    state.orders = [];
    state.seen = new Set();
    state.loaded = false;
    renderStores();
    renderLinks();
    $("vo-list").innerHTML = "";
    await refresh();
  });

  $("vo-filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderFilters();
    renderList();
  });

  $("vo-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act='ready']");
    if (!btn || state.busy) return;
    const order = state.orders.find((o) => o.id === btn.dataset.id);
    if (order) onReady(order);
  });

  $("vo-refresh").addEventListener("click", async () => {
    if (state.busy) return;
    const button = $("vo-refresh");
    button.disabled = true;
    await refresh();
    button.disabled = false;
  });
}
