import { supabase, isSupabaseConfigured } from "../modules/supabaseClient.js";
import { escapeHtml as esc, attrUrl } from "../modules/escape.js";
import { createOrdersModule } from "./admin-orders.js";
import { createPayoutsModule } from "./admin-payouts.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../data/supabaseConfig.js";
import { createChatAdminModule } from "./admin-chat.js";
import { createApprovalsModule } from "./admin-approvals.js";
import { prepareImage, MAX_ORIGINAL_BYTES } from "../modules/imageResize.js";

// WHAT: the admin dashboard — sign in, then add/edit/remove vendors and
// products, review vendor applications, and manage orders and payments.
// WHY: every action here talks to Supabase, and Supabase decides whether
// it is allowed (Row Level Security + the is_admin() checks in
// 01_schema.sql / 03_admin_catalog.sql). Hiding this page isn't the
// protection — the database is. A non-admin who opens this page can
// sign in, but every read and write is refused.
// FUTURE: orders and payment verification become a fourth tab here.

const BUCKET = "catalog-images";
const MAX_IMAGE_BYTES = MAX_ORIGINAL_BYTES; // big photos are shrunk before upload (imageResize.js)
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHONE_RE = /^[0-9+()\-\s]{7,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const state = {
  vendors: [],
  products: [],
  categories: [],
  schools: [],
  applications: [],
  transactions: [],
  flagged: [],
  flaggedError: "",
  approvals: [],
  approvalsError: "",
  balances: [],
  balancesError: "",
  refunds: [],
  tab: "orders",
  busy: false,
};

const $ = (id) => document.getElementById(id);

// Everything from the database is escaped before it touches innerHTML —
// vendor applications are written by the PUBLIC, so they are untrusted.
// (The shared helper lives in modules/escape.js.)

const naira = (n) => "₦" + Number(n).toLocaleString("en-NG");
const formatDate = (iso) => new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });

const vendorById = (id) => state.vendors.find((v) => v.id === id);
const categoryName = (id) => state.categories.find((c) => c.id === id)?.name ?? id;
const schoolLabel = (id) => state.schools.find((s) => s.id === id)?.abbreviation ?? id;

// ---------------------------------------------------------------------
// Start-up and views
// ---------------------------------------------------------------------

async function init() {
  wireStatic();

  if (!isSupabaseConfigured) {
    showView("setup-view");
    return;
  }

  // Only flips the screen — no Supabase calls inside this callback.
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      resetState();
      showView("auth-view");
    }
  });

  const { data } = await supabase.auth.getSession();
  if (data.session) await enterIfAdmin();
  else showView("auth-view");
}

function showView(id) {
  ["setup-view", "auth-view", "denied-view", "app-view"].forEach((v) => ($(v).hidden = v !== id));
  $("signout-btn").hidden = !(id === "app-view" || id === "denied-view");
}

function resetState() {
  Object.assign(state, { vendors: [], products: [], categories: [], schools: [], applications: [], transactions: [], flagged: [], flaggedError: "", approvals: [], approvalsError: "", balances: [], balancesError: "", refunds: [], tab: "orders", busy: false });
  $("accounts-dialog").open && $("accounts-dialog").close();
  $("order-dialog").open && $("order-dialog").close();
  $("form-dialog").open && $("form-dialog").close();
  $("confirm-dialog").open && $("confirm-dialog").close();
}

async function enterIfAdmin() {
  const { data: isAdmin, error } = await supabase.rpc("is_admin");
  if (error) {
    showLoginError(friendlyError(error));
    showView("auth-view");
    return;
  }
  if (isAdmin !== true) {
    showView("denied-view");
    return;
  }
  showView("app-view");
  await refresh();
  setTab("orders");
}

// Vendor phone, WhatsApp, email and owner name are admin-only (08_private_vendor_contacts.sql),
// so the full list comes from an admin-checked function. Before that SQL file
// has been run, the function doesn't exist yet and we read the table directly,
// so the dashboard works either way.
async function loadVendorsForAdmin() {
  const viaFunction = await supabase.rpc("admin_list_vendors");
  if (!viaFunction.error) return { data: viaFunction.data || [], error: null };
  return supabase.from("vendors").select("*").order("created_at", { ascending: false });
}

async function loadAll() {
  const results = await Promise.all([
    loadVendorsForAdmin(),
    supabase.from("products").select("*").order("created_at", { ascending: false }),
    supabase.from("categories").select("*").order("name"),
    supabase.from("schools").select("*").order("name"),
    supabase.from("vendor_applications").select("*").order("submitted_at", { ascending: false }),
    // Each transaction comes with its vendor orders and their items in one request.
    supabase.from("transactions").select("*, orders(*, order_items(*))").order("created_at", { ascending: false }).limit(200),
    supabase.rpc("admin_flagged_messages"),
    supabase.rpc("admin_pending_products"),
    supabase.rpc("admin_vendor_balances"),
    supabase.from("payment_refunds").select("*").order("created_at", { ascending: false }).limit(500),
  ]);
  const core = results.slice(0, 6);
  const failed = core.find((r) => r.error);
  if (failed) throw failed.error;
  [state.vendors, state.products, state.categories, state.schools, state.applications, state.transactions] = core.map((r) => r.data);

  // Chat is optional: if 06_chat.sql hasn't been run yet, the rest of the
  // dashboard still works and the Chats tab explains what to do.
  const flagged = results[6];
  state.flaggedError = flagged.error ? flagged.error.message || "unavailable" : "";
  state.flagged = flagged.error ? [] : flagged.data || [];

  // Vendor-submitted products are optional too: until 09_vendor_products.sql
  // has been run, the Approvals tab explains what to do.
  const pending = results[7];
  state.approvalsError = pending.error ? pending.error.message || "unavailable" : "";
  state.approvals = pending.error ? [] : pending.data || [];

  // Payouts and refunds are optional too: until 12_payouts_and_refunds.sql
  // has been run, the Payouts tab explains what to do and the rest works as before.
  const balances = results[8];
  state.balancesError = balances.error ? balances.error.message || "unavailable" : "";
  state.balances = balances.error ? [] : balances.data || [];
  const refunds = results[9];
  state.refunds = refunds.error ? [] : refunds.data || [];
}

async function refresh() {
  const banner = $("load-error");
  try {
    await loadAll();
    banner.style.display = "none";
  } catch (err) {
    banner.textContent = "Couldn't load data. " + friendlyError(err);
    banner.style.display = "block";
  }
  renderAll();
}

// ---------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------
// The Orders tab lives in admin-orders.js; it gets exactly what it needs.
// Asks the refund-payment Edge Function to refund an online payment. Only a
// signed-in admin is accepted by it; the amount is worked out by the database.
async function requestRefund(transactionId, orderId) {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : null;
  if (!token) return { ok: false, message: "Your session expired. Sign in again." };

  const messages = {
    not_configured: "Online refunds aren't set up yet. See database/PAYOUTS_AND_REFUNDS_SETUP.md.",
    admins_only: "Only admins can refund payments.",
    not_online: "This payment wasn't made online. Refund it yourself, then mark it Refunded.",
    provider_unreachable: "Couldn't reach Paystack, so nothing was refunded. Try again.",
    slow_down: "Please wait a moment and try again.",
  };
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/refund-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transactionId, orderId: orderId || null }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body && body.ok) return { ok: true, ...body };
    const detail = body && body.message ? ` ${body.message}` : "";
    if (body && body.error === "provider_refused") return { ok: false, message: `Paystack refused the refund.${detail}` };
    if (body && (body.error === "refused" || body.error === "recorded_failed")) return { ok: false, message: body.message || "This refund isn't allowed." };
    return { ok: false, message: messages[body && body.error] || "The refund didn't go through. Nothing was refunded. Try again." };
  } catch (_) {
    return { ok: false, message: "Couldn't reach the server. Nothing was refunded. Check your connection and try again." };
  }
}

const orders = createOrdersModule({
  supabase,
  getTransactions: () => state.transactions,
  getRefunds: () => state.refunds,
  requestRefund,
  getVendor: (id) => state.vendors.find((v) => v.id === id),
  esc,
  toast: (message, isError) => toast(message, isError),
  confirmDialog: (options) => confirmDialog(options),
  friendlyError: (err) => friendlyError(err),
  refresh: () => refresh(),
  isBusy: () => state.busy,
  setBusy: (value) => {
    state.busy = value;
  },
});

const payouts = createPayoutsModule({
  supabase,
  getBalances: () => state.balances,
  getBalancesError: () => state.balancesError,
  esc,
  toast: (message, isError) => toast(message, isError),
  confirmDialog: (options) => confirmDialog(options),
  friendlyError: (err) => friendlyError(err),
  refresh: () => refresh(),
  isBusy: () => state.busy,
  setBusy: (value) => {
    state.busy = value;
  },
});

const approvals = createApprovalsModule({
  supabase,
  getApprovals: () => state.approvals,
  getApprovalsError: () => state.approvalsError,
  getCategories: () => state.categories,
  esc,
  toast: (message, isError) => toast(message, isError),
  confirmDialog: (options) => confirmDialog(options),
  friendlyError: (err) => friendlyError(err),
  refresh: () => refresh(),
  isBusy: () => state.busy,
  setBusy: (value) => {
    state.busy = value;
  },
});

const chats = createChatAdminModule({
  supabase,
  getFlagged: () => state.flagged,
  getFlaggedError: () => state.flaggedError,
  getVendor: (id) => state.vendors.find((v) => v.id === id),
  esc,
  toast: (message, isError) => toast(message, isError),
  friendlyError: (err) => friendlyError(err),
  refresh: () => refresh(),
  isBusy: () => state.busy,
  setBusy: (value) => {
    state.busy = value;
  },
});

function wireStatic() {
  orders.wire();
  payouts.wire();
  approvals.wire();
  chats.wire();
  $("login-form").addEventListener("submit", onLogin);
  $("signout-btn").addEventListener("click", signOut);
  $("denied-signout").addEventListener("click", signOut);

  const tabs = document.querySelectorAll("[data-tab]");
  tabs.forEach((btn, i) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      setTab(next.dataset.tab);
    });
  });

  $("vendor-search").addEventListener("input", renderVendors);
  $("product-search").addEventListener("input", renderProducts);
  $("product-vendor-filter").addEventListener("change", renderProducts);
  $("application-filter").addEventListener("change", renderApplications);

  $("add-vendor-btn").addEventListener("click", () => openVendorForm(null));
  $("add-product-btn").addEventListener("click", () => openProductForm(null));

  $("vendor-list").addEventListener("click", onListClick);
  $("product-list").addEventListener("click", onListClick);
  $("application-list").addEventListener("click", onListClick);
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.setAttribute("aria-selected", String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  ["orders", "payouts", "approvals", "chats", "vendors", "products", "applications"].forEach((t) => ($("panel-" + t).hidden = t !== tab));
}

// ---------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------
async function onLogin(e) {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const btn = $("login-submit");

  if (!email || !password) {
    showLoginError("Enter your email and password.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Signing in…";
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = "Sign in";

  if (error) {
    showLoginError(error.message === "Invalid login credentials" ? "Incorrect email or password." : friendlyError(error));
    return;
  }
  $("login-password").value = "";
  $("login-error").style.display = "none";
  await enterIfAdmin();
}

function showLoginError(message) {
  const el = $("login-error");
  el.textContent = message;
  el.style.display = "block";
}

async function signOut() {
  await supabase.auth.signOut();
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function renderAll() {
  $("count-vendors").textContent = state.vendors.length;
  $("count-products").textContent = state.products.length;
  $("count-applications").textContent = state.applications.filter((a) => a.status === "pending_review").length || "";

  const filter = $("product-vendor-filter");
  const current = filter.value;
  filter.innerHTML =
    `<option value="">All vendors</option>` +
    state.vendors.map((v) => `<option value="${esc(v.id)}">${esc(v.store_name)}</option>`).join("");
  filter.value = state.vendors.some((v) => v.id === current) ? current : "";

  orders.render();
  payouts.render();
  approvals.render();
  chats.render();
  renderVendors();
  renderProducts();
  renderApplications();
}

function thumb(image, name) {
  const initial = esc((name || "?").trim().charAt(0).toUpperCase());
  return `<div class="admin-thumb" data-initial="${initial}">${image ? `<img src="${attrUrl(image)}" alt="" loading="lazy" />` : initial}</div>`;
}

// A broken image URL falls back to the initial letter instead of a broken icon.
function wireThumbFallbacks(root) {
  root.querySelectorAll(".admin-thumb img").forEach((img) => {
    img.addEventListener("error", () => {
      img.parentElement.textContent = img.parentElement.dataset.initial;
    });
  });
}

function emptyState(title, body) {
  return `<div class="empty-state"><h3>${esc(title)}</h3><p style="margin-inline:auto">${esc(body)}</p></div>`;
}

function renderVendors() {
  const q = $("vendor-search").value.trim().toLowerCase();
  const list = state.vendors.filter((v) => !q || [v.store_name, v.owner_name, v.location].join(" ").toLowerCase().includes(q));
  const el = $("vendor-list");

  if (!state.vendors.length) {
    el.innerHTML = emptyState("No vendors yet", "Add your first vendor, or approve an application.");
    return;
  }
  if (!list.length) {
    el.innerHTML = emptyState("No matches", "Try a different search.");
    return;
  }

  el.innerHTML = list
    .map((v) => {
      const productCount = state.products.filter((p) => p.vendor_id === v.id).length;
      return `
      <article class="admin-row ${v.active ? "" : "admin-row--inactive"}">
        ${thumb(v.image, v.store_name)}
        <div>
          <div class="admin-row__title">
            <h3>${esc(v.store_name)}</h3>
            ${v.active ? "" : '<span class="badge badge-danger">Hidden from shop</span>'}
            ${v.verified ? '<span class="badge badge-verified">Verified</span>' : ""}
          </div>
          <div class="admin-row__meta">
            <span>${esc(v.owner_name)}</span>
            <span>${esc(categoryName(v.category_id))}, ${esc(schoolLabel(v.school_id))}</span>
            <span>${esc(v.location)}</span>
            <span>${productCount} ${productCount === 1 ? "product" : "products"}</span>
          </div>
        </div>
        <div class="admin-row__actions">
          <button type="button" class="btn btn-outline btn-sm" data-action="edit-vendor" data-id="${esc(v.id)}">Edit</button>
          <button type="button" class="btn btn-outline btn-sm" data-action="vendor-accounts" data-id="${esc(v.id)}">Logins</button>
          ${
            v.active
              ? `<button type="button" class="btn btn-danger btn-sm" data-action="remove-vendor" data-id="${esc(v.id)}">Remove</button>`
              : `<button type="button" class="btn btn-outline btn-sm" data-action="restore-vendor" data-id="${esc(v.id)}">Show in shop</button>`
          }
        </div>
      </article>`;
    })
    .join("");
  wireThumbFallbacks(el);
}

function renderProducts() {
  const q = $("product-search").value.trim().toLowerCase();
  const vendorId = $("product-vendor-filter").value;
  const list = state.products.filter(
    (p) => (!vendorId || p.vendor_id === vendorId) && (!q || p.name.toLowerCase().includes(q))
  );
  const el = $("product-list");

  if (!state.products.length) {
    el.innerHTML = emptyState("No products yet", "Add a product and assign it to a vendor.");
    return;
  }
  if (!list.length) {
    el.innerHTML = emptyState("No matches", "Try a different search or vendor.");
    return;
  }

  const availability = {
    "in-stock": '<span class="badge">Available</span>',
    limited: '<span class="badge badge-accent">Limited stock</span>',
    unavailable: '<span class="badge badge-outline">Unavailable</span>',
  };

  el.innerHTML = list
    .map((p) => {
      const vendor = vendorById(p.vendor_id);
      return `
      <article class="admin-row ${p.active ? "" : "admin-row--inactive"}">
        ${thumb(p.image, p.name)}
        <div>
          <div class="admin-row__title">
            <h3>${esc(p.name)}</h3>
            ${!p.active ? '<span class="badge badge-danger">Hidden from shop</span>' : p.status === "pending" ? '<span class="badge badge-accent">Waiting for approval</span>' : p.status === "rejected" ? '<span class="badge badge-danger">Not approved</span>' : availability[p.availability] || ""}
          </div>
          <div class="admin-row__meta">
            <strong>${naira(p.price)}</strong>
            <span>${esc(vendor ? vendor.store_name : "Unknown vendor")}</span>
            <span>${esc(categoryName(p.category_id))}</span>
          </div>
        </div>
        <div class="admin-row__actions">
          <button type="button" class="btn btn-outline btn-sm" data-action="edit-product" data-id="${esc(p.id)}">Edit</button>
          ${
            p.active
              ? `<button type="button" class="btn btn-danger btn-sm" data-action="remove-product" data-id="${esc(p.id)}">Remove</button>`
              : `<button type="button" class="btn btn-outline btn-sm" data-action="restore-product" data-id="${esc(p.id)}">Show in shop</button>`
          }
        </div>
      </article>`;
    })
    .join("");
  wireThumbFallbacks(el);
}

function renderApplications() {
  const filter = $("application-filter").value;
  const list = state.applications.filter((a) => filter === "all" || a.status === filter);
  const el = $("application-list");

  if (!list.length) {
    el.innerHTML = emptyState(
      filter === "pending_review" ? "No applications waiting" : "Nothing here",
      filter === "pending_review" ? "New vendor applications will show up here." : "No applications match this filter."
    );
    return;
  }

  const statusBadge = {
    pending_review: '<span class="badge badge-accent">Waiting for review</span>',
    approved: '<span class="badge">Approved</span>',
    rejected: '<span class="badge badge-outline">Rejected</span>',
  };

  el.innerHTML = list
    .map(
      (a) => `
      <article class="admin-row">
        ${thumb(null, a.store_name)}
        <div>
          <div class="admin-row__title">
            <h3>${esc(a.store_name)}</h3>
            ${statusBadge[a.status] || ""}
          </div>
          <div class="admin-row__meta">
            <span>${esc(a.owner_name)}</span>
            <span>${esc(a.phone)}</span>
            <span>${esc(a.email)}</span>
            <span>${esc(categoryName(a.category_id))}, ${esc(schoolLabel(a.school_id))}</span>
            <span>${esc(a.location)}</span>
            <span>Applied ${esc(formatDate(a.submitted_at))}</span>
          </div>
          <p class="admin-row__text">${esc(a.description)}</p>
        </div>
        ${
          a.status === "pending_review"
            ? `<div class="admin-row__actions">
                <button type="button" class="btn btn-primary btn-sm" data-action="approve-application" data-id="${esc(a.id)}">Approve</button>
                <button type="button" class="btn btn-danger btn-sm" data-action="reject-application" data-id="${esc(a.id)}">Reject</button>
              </div>`
            : ""
        }
      </article>`
    )
    .join("");
  wireThumbFallbacks(el);
}

// ---------------------------------------------------------------------
// List actions (one click handler per list — "event delegation")
// ---------------------------------------------------------------------
function onListClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn || state.busy) return;
  const { action, id } = btn.dataset;

  const actions = {
    "edit-vendor": () => openVendorForm(vendorById(id)),
    "vendor-accounts": () => chats.openAccounts(id),
    "remove-vendor": () => removeVendor(id),
    "restore-vendor": () => restore("vendors", id, "Vendor is visible in the shop again."),
    "edit-product": () => openProductForm(state.products.find((p) => p.id === id)),
    "remove-product": () => removeProduct(id),
    "restore-product": () => restore("products", id, "Product is visible in the shop again."),
    "approve-application": () => approveApplication(Number(id)),
    "reject-application": () => rejectApplication(Number(id)),
  };
  actions[action]?.();
}

// Runs an async action with a busy lock + error toast, then reloads data.
async function run(task) {
  state.busy = true;
  try {
    await task();
    await refresh();
  } catch (err) {
    toast(friendlyError(err), true);
  } finally {
    state.busy = false;
  }
}

async function removeVendor(id) {
  const vendor = vendorById(id);
  const n = state.products.filter((p) => p.vendor_id === id).length;
  const ok = await confirmDialog({
    title: `Remove ${vendor.store_name}?`,
    body:
      "If this vendor has past orders, it is hidden from the shop but kept in your order history. Otherwise it is deleted permanently" +
      (n ? `, along with its ${n} ${n === 1 ? "product" : "products"}.` : "."),
    okLabel: "Remove vendor",
    danger: true,
  });
  if (!ok) return;

  await run(async () => {
    const { data, error } = await supabase.rpc("remove_vendor", { p_vendor_id: id });
    if (error) throw error;
    toast(data === "deleted" ? `${vendor.store_name} was deleted.` : `${vendor.store_name} is hidden from the shop. Its orders are kept.`);
  });
}

async function removeProduct(id) {
  const product = state.products.find((p) => p.id === id);
  const ok = await confirmDialog({
    title: `Remove ${product.name}?`,
    body: "If this product is in past orders, it is hidden from the shop but kept in order history. Otherwise it is deleted permanently.",
    okLabel: "Remove product",
    danger: true,
  });
  if (!ok) return;

  await run(async () => {
    const { data, error } = await supabase.rpc("remove_product", { p_product_id: id });
    if (error) throw error;
    toast(data === "deleted" ? `${product.name} was deleted.` : `${product.name} is hidden from the shop. Its orders are kept.`);
  });
}

async function restore(table, id, message) {
  await run(async () => {
    const { data, error } = await supabase.from(table).update({ active: true }).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("Nothing was saved. Check that you're signed in as an admin.");
    toast(message);
  });
}

async function approveApplication(id) {
  const app = state.applications.find((a) => a.id === id);
  const ok = await confirmDialog({
    title: `Approve ${app.store_name}?`,
    body: "This adds them to the marketplace as a vendor right away. You can then add their products.",
    okLabel: "Approve and add vendor",
    danger: false,
  });
  if (!ok) return;

  await run(async () => {
    const { error } = await supabase.rpc("approve_vendor_application", { p_application_id: id });
    if (error) throw error;
    toast(`${app.store_name} is now a vendor. Add their products next.`);
    setTab("vendors");
  });
}

async function rejectApplication(id) {
  const app = state.applications.find((a) => a.id === id);
  const ok = await confirmDialog({
    title: `Reject ${app.store_name}?`,
    body: "The application is marked as rejected. No vendor is created.",
    okLabel: "Reject application",
    danger: true,
  });
  if (!ok) return;

  await run(async () => {
    const { data, error } = await supabase
      .from("vendor_applications")
      .update({ status: "rejected" })
      .eq("id", id)
      .eq("status", "pending_review")
      .select();
    if (error) throw error;
    if (!data?.length) throw new Error("This application was already reviewed.");
    toast(`${app.store_name} was rejected.`);
  });
}

// ---------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------
function confirmDialog({ title, body, okLabel, danger }) {
  return new Promise((resolve) => {
    const dlg = $("confirm-dialog");
    const ok = $("confirm-ok");
    $("confirm-title").textContent = title;
    $("confirm-body").textContent = body;
    ok.textContent = okLabel;
    ok.className = "btn " + (danger ? "btn-danger-solid" : "btn-primary");

    let confirmed = false;
    ok.onclick = () => {
      confirmed = true;
      dlg.close();
    };
    $("confirm-cancel").onclick = () => dlg.close();
    dlg.onclose = () => resolve(confirmed);
    dlg.showModal();
  });
}

function openForm({ title, fieldsHtml, submitLabel, onSubmit, onOpen }) {
  const dlg = $("form-dialog");
  const form = $("entity-form");

  form.innerHTML = `
    <h2 id="form-dialog-title">${esc(title)}</h2>
    ${fieldsHtml}
    <div class="form-submit-error" id="form-error" role="alert"></div>
    <div class="admin-dialog__actions">
      <button type="button" class="btn btn-outline" id="form-cancel">Cancel</button>
      <button type="submit" class="btn btn-primary" id="form-submit">${esc(submitLabel)}</button>
    </div>`;

  $("form-cancel").onclick = () => dlg.close();

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (state.busy) return;
    clearFormErrors(form);

    const btn = $("form-submit");
    btn.disabled = true;
    btn.textContent = "Saving…";
    state.busy = true;
    try {
      const result = await onSubmit();
      if (result !== false) {
        dlg.close();
        await refresh();
      }
    } catch (err) {
      showFormError(friendlyError(err));
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = submitLabel;
    }
  };

  onOpen?.();
  dlg.showModal();
}

// ---- field builders ----
function inputField({ id, label, type = "text", value = "", hint = "", attrs = "" }) {
  return `<div class="form-group">
    <label for="${id}">${esc(label)}</label>
    <input type="${type}" id="${id}" value="${esc(value)}" ${attrs} />
    ${hint ? `<span class="form-hint">${esc(hint)}</span>` : ""}
    <span class="field-error" id="${id}-error"></span>
  </div>`;
}

function textareaField({ id, label, value = "", attrs = "" }) {
  return `<div class="form-group">
    <label for="${id}">${esc(label)}</label>
    <textarea id="${id}" rows="4" ${attrs}>${esc(value)}</textarea>
    <span class="field-error" id="${id}-error"></span>
  </div>`;
}

function selectField({ id, label, options, value = "", placeholder = "" }) {
  const opts = options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  return `<div class="form-group">
    <label for="${id}">${esc(label)}</label>
    <select id="${id}">${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}${opts}</select>
    <span class="field-error" id="${id}-error"></span>
  </div>`;
}

function checkField({ id, label, checked }) {
  return `<label class="form-check"><input type="checkbox" id="${id}" ${checked ? "checked" : ""} /> ${esc(label)}</label>`;
}

function imageField({ id, label, current, name }) {
  return `<div class="form-group">
    <label for="${id}">${esc(label)}</label>
    <div class="image-field">
      <div id="${id}-preview">${thumb(current, name)}</div>
      <input type="file" id="${id}" accept="image/jpeg,image/png,image/webp" />
    </div>
    <span class="form-hint">JPG, PNG or WebP. Big photos are shrunk for you.</span>
    <span class="field-error" id="${id}-error"></span>
  </div>`;
}

function wireImagePreview(id, name) {
  const input = $(id);
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    $(id + "-preview").innerHTML = `<div class="admin-thumb"><img src="${url}" alt="Selected image preview" /></div>`;
  });
}

// ---- form helpers ----
const val = (id) => $(id).value.trim();

function fieldError(id, message) {
  const input = $(id);
  input?.classList.add("has-error");
  const el = $(id + "-error");
  if (el) el.textContent = message;
}

function clearFormErrors(form) {
  form.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
  form.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  const banner = $("form-error");
  if (banner) banner.style.display = "none";
}

function showFormError(message) {
  const banner = $("form-error");
  banner.textContent = message;
  banner.style.display = "block";
}

function focusFirstError(form) {
  form.querySelector(".has-error")?.focus();
}

function checkImage(file) {
  if (!file) return "";
  if (!IMAGE_TYPES.includes(file.type)) return "Use a JPG, PNG or WebP image.";
  if (file.size > MAX_IMAGE_BYTES) return "That image is over 15 MB. Choose a smaller one.";
  return "";
}

async function uploadImage(original, folder) {
  const prepared = await prepareImage(original); // shrink first
  if (!prepared.ok) throw new Error(prepared.error);
  const file = prepared.file;
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function save(table, id, values) {
  const query = id ? supabase.from(table).update(values).eq("id", id) : supabase.from(table).insert(values);
  // Only the id comes back: asking for every column would be refused for vendors.
  const { data, error } = await query.select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("Nothing was saved. Check that you're signed in as an admin.");
}

// ---------------------------------------------------------------------
// Vendor form
// ---------------------------------------------------------------------
function openVendorForm(vendor) {
  const v = vendor || {};
  const form = $("entity-form");

  const fieldsHtml = `
    ${inputField({ id: "f-store", label: "Store name", value: v.store_name, attrs: 'autocomplete="off"' })}
    <div class="form-row">
      ${inputField({ id: "f-owner", label: "Owner name", value: v.owner_name })}
      ${inputField({ id: "f-email", label: "Email", type: "email", value: v.email })}
    </div>
    <div class="form-row">
      ${inputField({ id: "f-phone", label: "Phone", type: "tel", value: v.phone })}
      ${inputField({ id: "f-whatsapp", label: "WhatsApp", type: "tel", value: v.whatsapp, hint: "Include the country code, e.g. +234…" })}
    </div>
    <div class="form-row">
      ${selectField({ id: "f-category", label: "Category", value: v.category_id, placeholder: "Choose a category", options: state.categories.map((c) => ({ value: c.id, label: c.name })) })}
      ${selectField({ id: "f-school", label: "School", value: v.school_id, placeholder: "Choose a school", options: state.schools.map((s) => ({ value: s.id, label: s.name })) })}
    </div>
    ${inputField({ id: "f-location", label: "Location", value: v.location, hint: "Where students can find them, e.g. Behind the main gate." })}
    ${textareaField({ id: "f-description", label: "Description", value: v.description })}
    ${imageField({ id: "f-image", label: "Store image", current: v.image, name: v.store_name })}
    ${checkField({ id: "f-verified", label: "Verified vendor", checked: vendor ? v.verified : false })}
    ${checkField({ id: "f-active", label: "Show in the shop", checked: vendor ? v.active : true })}`;

  openForm({
    title: vendor ? "Edit vendor" : "Add vendor",
    fieldsHtml,
    submitLabel: vendor ? "Save changes" : "Add vendor",
    onOpen: () => wireImagePreview("f-image"),
    onSubmit: async () => {
      const values = {
        store_name: val("f-store"),
        owner_name: val("f-owner"),
        email: val("f-email"),
        phone: val("f-phone"),
        whatsapp: val("f-whatsapp"),
        category_id: val("f-category"),
        school_id: val("f-school"),
        location: val("f-location"),
        description: val("f-description"),
        verified: $("f-verified").checked,
        active: $("f-active").checked,
      };
      const file = $("f-image").files[0];

      let invalid = false;
      const need = (id, ok, msg) => {
        if (!ok) {
          fieldError(id, msg);
          invalid = true;
        }
      };
      need("f-store", values.store_name, "Enter the store name.");
      need("f-owner", values.owner_name, "Enter the owner's name.");
      need("f-email", EMAIL_RE.test(values.email), "Enter a valid email address.");
      need("f-phone", PHONE_RE.test(values.phone), "Enter a valid phone number.");
      need("f-whatsapp", PHONE_RE.test(values.whatsapp), "Enter a valid WhatsApp number.");
      need("f-category", values.category_id, "Choose a category.");
      need("f-school", values.school_id, "Choose a school.");
      need("f-location", values.location, "Enter the store's location.");
      need("f-description", values.description.length >= 10, "Write at least 10 characters.");
      const imageProblem = checkImage(file);
      need("f-image", !imageProblem, imageProblem);
      if (invalid) {
        focusFirstError(form);
        return false;
      }

      if (file) values.image = await uploadImage(file, "vendors");
      await save("vendors", vendor?.id, values);
      toast(vendor ? "Vendor saved." : `${values.store_name} was added.`);
    },
  });
}

// ---------------------------------------------------------------------
// Product form
// ---------------------------------------------------------------------
function openProductForm(product) {
  const p = product || {};
  const form = $("entity-form");

  // New products can only go to visible vendors; an existing product keeps its current vendor listed.
  const vendorOptions = state.vendors
    .filter((v) => v.active || v.id === p.vendor_id)
    .map((v) => ({ value: v.id, label: v.store_name }));

  if (!vendorOptions.length) {
    toast("Add a vendor first, then you can add products.", true);
    return;
  }

  const preselected = $("product-vendor-filter").value;
  const startVendor = p.vendor_id || (vendorOptions.some((o) => o.value === preselected) ? preselected : "");

  const fieldsHtml = `
    ${inputField({ id: "f-name", label: "Product name", value: p.name, attrs: 'autocomplete="off"' })}
    ${selectField({ id: "f-vendor", label: "Vendor", value: startVendor, placeholder: "Choose a vendor", options: vendorOptions })}
    <div class="form-row">
      ${inputField({ id: "f-price", label: "Price (₦)", type: "number", value: p.price ?? "", attrs: 'min="0" step="1" inputmode="numeric"' })}
      ${selectField({
        id: "f-availability",
        label: "Availability",
        value: p.availability || "in-stock",
        options: [
          { value: "in-stock", label: "Available" },
          { value: "limited", label: "Limited stock" },
          { value: "unavailable", label: "Unavailable" },
        ],
      })}
    </div>
    ${selectField({ id: "f-category", label: "Category", value: p.category_id, placeholder: "Choose a category", options: state.categories.map((c) => ({ value: c.id, label: c.name })) })}
    ${textareaField({ id: "f-description", label: "Description", value: p.description })}
    ${imageField({ id: "f-image", label: "Product image", current: p.image, name: p.name })}
    ${checkField({ id: "f-active", label: "Show in the shop", checked: product ? p.active : true })}`;

  openForm({
    title: product ? "Edit product" : "Add product",
    fieldsHtml,
    submitLabel: product ? "Save changes" : "Add product",
    onOpen: () => {
      wireImagePreview("f-image");
      // For a new product, picking a vendor suggests that vendor's category.
      $("f-vendor").addEventListener("change", () => {
        const vendor = vendorById($("f-vendor").value);
        if (vendor && !$("f-category").value) $("f-category").value = vendor.category_id;
      });
    },
    onSubmit: async () => {
      const vendor = vendorById(val("f-vendor"));
      const priceText = val("f-price");
      const values = {
        name: val("f-name"),
        vendor_id: vendor?.id || "",
        school_id: vendor?.school_id || "",
        price: Number(priceText),
        availability: val("f-availability"),
        category_id: val("f-category"),
        description: val("f-description"),
        active: $("f-active").checked,
      };
      const file = $("f-image").files[0];

      let invalid = false;
      const need = (id, ok, msg) => {
        if (!ok) {
          fieldError(id, msg);
          invalid = true;
        }
      };
      need("f-name", values.name, "Enter the product name.");
      need("f-vendor", vendor, "Choose a vendor.");
      need("f-price", priceText !== "" && Number.isInteger(values.price) && values.price >= 0, "Enter a whole-number price, 0 or more.");
      need("f-category", values.category_id, "Choose a category.");
      need("f-description", values.description.length >= 10, "Write at least 10 characters.");
      const imageProblem = checkImage(file);
      need("f-image", !imageProblem, imageProblem);
      if (invalid) {
        focusFirstError(form);
        return false;
      }

      if (file) values.image = await uploadImage(file, "products");
      await save("products", product?.id, values);
      toast(product ? "Product saved." : `${values.name} was added.`);
    },
  });
}

// ---------------------------------------------------------------------
// Toast + errors
// ---------------------------------------------------------------------
let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "admin-toast" + (isError ? " admin-toast--error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 4500);
}

// Turns raw database errors into something an admin can act on.
function friendlyError(err) {
  const msg = (err && err.message) || "";
  if (/row-level security|permission denied|Admins only/i.test(msg)) return "You don't have permission to do that. Sign in with an admin account.";
  if (/JWT expired|not authenticated/i.test(msg)) return "Your session expired. Sign in again.";
  if (/foreign key/i.test(msg)) return "This item is linked to other records, so it can't be changed that way.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach Supabase. Check your internet connection.";
  return msg || "Something went wrong. Try again.";
}

// Start-up goes LAST, so everything above (including the Orders module)
// exists before init() runs. It runs whether the script executes before or
// after the page finishes parsing.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
