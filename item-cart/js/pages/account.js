import { renderHeader, renderFooter } from "../modules/layout.js";
import { isBackendConfigured } from "../modules/backend.js";
import { getMyVendors } from "../modules/chat.js";
import { formatNaira } from "../modules/render.js";
import { escapeHtml as esc } from "../modules/escape.js";
import {
  MIN_PASSWORD_LENGTH,
  getSession,
  onAuthChange,
  signUp,
  signIn,
  signOut,
  requestPasswordReset,
  setNewPassword,
  getProfile,
  saveProfile,
  getMyOrders,
  claimPendingCheckout,
} from "../modules/auth.js";

// WHAT: the account page. Signed out → sign in / create account.
// Signed in → order history and details.
// WHY: one page, one URL (account.html), so email links (confirm your
// email, reset your password) and the header icon all land in one place.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-\s]{7,}$/;

const VIEWS = ["account-loading", "setup-view", "auth-view", "confirm-view", "recovery-view", "dashboard-view"];

const STATUS_STYLES = {
  paid: "badge-verified",
  completed: "badge-verified",
  pending: "badge-accent",
  awaiting_verification: "badge-accent",
  failed: "badge-danger",
  cancelled: "badge-danger",
  refunded: "badge-outline",
};

const state = { recovery: false, session: null };

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("account.html");
  renderFooter();

  if (!isBackendConfigured) {
    showView("setup-view");
    return;
  }

  wireForms();
  const params = new URLSearchParams(window.location.search);
  if (params.get("tab") === "signup") setAuthTab("signup");

  await onAuthChange((event) => {
    // Only flip a flag here and re-route afterwards; no Supabase calls
    // inside this callback.
    if (event === "PASSWORD_RECOVERY") state.recovery = true;
    if (event === "PASSWORD_RECOVERY" || event === "SIGNED_OUT") setTimeout(route, 0);
  });

  await route();
});

function showView(id) {
  VIEWS.forEach((v) => {
    const el = $(v);
    if (el) el.style.display = v === id ? "block" : "none";
  });
}

async function route() {
  state.session = await getSession();

  if (state.recovery && state.session) {
    showView("recovery-view");
    return;
  }
  if (!state.session) {
    showView("auth-view");
    return;
  }
  await showDashboard();
}

// ---------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------
function wireForms() {
  document.querySelectorAll("[data-auth-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setAuthTab(btn.dataset.authTab));
  });

  $("signin-form").addEventListener("submit", onSignIn);
  $("signup-form").addEventListener("submit", onSignUp);
  $("reset-form").addEventListener("submit", onReset);
  $("recovery-form").addEventListener("submit", onRecovery);
  $("profile-form").addEventListener("submit", onSaveProfile);

  $("forgot-btn").addEventListener("click", () => {
    $("signin-form").style.display = "none";
    $("reset-form").style.display = "block";
    $("reset-email").value = $("signin-email").value.trim();
    $("reset-email").focus();
  });
  $("reset-back").addEventListener("click", () => {
    $("reset-form").style.display = "none";
    $("signin-form").style.display = "block";
  });
  $("confirm-back").addEventListener("click", () => {
    setAuthTab("signin");
    showView("auth-view");
  });
  $("signout-btn").addEventListener("click", async () => {
    await signOut();
  });
}

function setAuthTab(tab) {
  document.querySelectorAll("[data-auth-tab]").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.authTab === tab));
  });
  $("signin-panel").hidden = tab !== "signin";
  $("signup-panel").hidden = tab !== "signup";
}

function clearErrors(form) {
  form.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
  form.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  form.querySelectorAll(".form-submit-error").forEach((el) => (el.style.display = "none"));
}

function fieldError(id, message) {
  $(id).classList.add("has-error");
  $(id + "-error").textContent = message;
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.style.display = "block";
}

async function withBusy(button, busyLabel, task) {
  const idle = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = idle;
  }
}

// Only same-site pages may be used as a "go back to" target, so a crafted
// link can't send someone to another website after they sign in.
function safeNextPage() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && /^[a-z0-9-]+\.html(\?[^\s]*)?$/i.test(next) ? next : null;
}

async function onSignIn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);

  const email = $("signin-email").value.trim();
  const password = $("signin-password").value;
  let invalid = false;
  if (!EMAIL_RE.test(email)) (fieldError("signin-email", "Enter a valid email address."), (invalid = true));
  if (!password) (fieldError("signin-password", "Enter your password."), (invalid = true));
  if (invalid) return;

  const result = await withBusy($("signin-submit"), "Signing in…", () => signIn({ email, password }));
  if (!result.ok) {
    showError("signin-error", result.error);
    return;
  }

  $("signin-password").value = "";
  const next = safeNextPage();
  if (next) {
    // Save any just-placed guest order first, then go where they were headed.
    await claimPendingCheckout();
    window.location.href = next;
    return;
  }
  await route();
}

async function onSignUp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);

  const fullName = $("signup-name").value.trim();
  const phone = $("signup-phone").value.trim();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value;

  let invalid = false;
  const need = (id, ok, msg) => {
    if (!ok) {
      fieldError(id, msg);
      invalid = true;
    }
  };
  need("signup-name", fullName && fullName.length <= 120, "Enter your full name.");
  need("signup-phone", PHONE_RE.test(phone) && phone.length <= 30, "Enter a valid phone number.");
  need("signup-email", EMAIL_RE.test(email), "Enter a valid email address.");
  need("signup-password", password.length >= MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (invalid) {
    form.querySelector(".has-error")?.focus();
    return;
  }

  const result = await withBusy($("signup-submit"), "Creating account…", () => signUp({ fullName, phone, email, password }));
  if (!result.ok) {
    showError("signup-error", result.error);
    return;
  }

  $("signup-password").value = "";
  if (result.needsConfirmation) {
    $("confirm-email").textContent = email;
    showView("confirm-view");
    return;
  }

  const next = safeNextPage();
  if (next) {
    await claimPendingCheckout();
    window.location.href = next;
    return;
  }
  await route();
}

async function onReset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);
  $("reset-sent").style.display = "none";

  const email = $("reset-email").value.trim();
  if (!EMAIL_RE.test(email)) {
    fieldError("reset-email", "Enter a valid email address.");
    return;
  }

  const result = await withBusy($("reset-submit"), "Sending…", () => requestPasswordReset(email));
  if (!result.ok) {
    showError("reset-error", result.error);
    return;
  }
  // Same message whether or not the email has an account, so this form
  // can't be used to find out who is registered.
  $("reset-sent").style.display = "block";
}

async function onRecovery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);

  const password = $("recovery-password").value;
  if (password.length < MIN_PASSWORD_LENGTH) {
    fieldError("recovery-password", `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    return;
  }

  const result = await withBusy($("recovery-submit"), "Saving…", () => setNewPassword(password));
  if (!result.ok) {
    showError("recovery-error", result.error);
    return;
  }

  state.recovery = false;
  $("recovery-password").value = "";
  window.history.replaceState({}, "", "account.html");
  await route();
}

// ---------------------------------------------------------------------
// Signed-in dashboard
// ---------------------------------------------------------------------
async function showDashboard() {
  const user = state.session.user;
  showView("dashboard-view");
  $("account-email").textContent = user.email || "";

  // A guest order placed in this browser is saved to the account first,
  // so it shows up in the history below straight away.
  const claimed = await claimPendingCheckout();

  const [profile, history, myVendors] = await Promise.all([getProfile(user.id), getMyOrders(), getMyVendors()]);

  const name = (profile && profile.full_name) || (user.user_metadata && user.user_metadata.full_name) || "";
  $("account-greeting").textContent = name ? `Hi, ${name.split(" ")[0]}` : "Your account";
  $("profile-name").value = name;
  $("profile-phone").value = (profile && profile.phone) || (user.user_metadata && user.user_metadata.phone) || "";

  const banner = $("account-banner");
  if (claimed) {
    banner.textContent = "Your recent order was saved to your account.";
    banner.style.display = "block";
  } else {
    banner.style.display = "none";
  }

  renderOrders(history);
  renderMessageLinks(myVendors);
}

// Everyone gets "My messages". Someone linked to a store (by you, in the
// admin page) also gets that store's inbox.
function renderMessageLinks(myVendors) {
  $("account-messages").innerHTML =
    `<a class="btn btn-outline" href="messages.html">My messages</a>` +
    myVendors
      .map(
        (v) =>
          `<a class="btn btn-primary" href="vendor-orders.html?store=${encodeURIComponent(v.id)}">Orders: ${esc(v.storeName)}</a>` +
          `<a class="btn btn-primary" href="messages.html?as=${encodeURIComponent(v.id)}">Inbox: ${esc(v.storeName)}</a>` +
          `<a class="btn btn-primary" href="vendor-products.html?store=${encodeURIComponent(v.id)}">Manage products: ${esc(v.storeName)}</a>`
      )
      .join("");
}

function renderOrders({ ok, orders }) {
  const el = $("account-orders");

  if (!ok) {
    el.innerHTML = `<div class="empty-state"><h3>We couldn't load your orders.</h3><p style="margin-inline:auto">Check your connection and refresh the page.</p></div>`;
    return;
  }
  if (!orders.length) {
    el.innerHTML = `
      <div class="empty-state">
        <h3>No orders yet</h3>
        <p style="margin-inline:auto">Orders you place while signed in will always be here.</p>
        <a href="marketplace.html" class="btn btn-primary btn-sm">Explore Marketplace</a>
      </div>`;
    return;
  }
  el.innerHTML = orders.map(orderCard).join("");
}

function statusBadge(label, status) {
  const extra = STATUS_STYLES[status] ?? "badge-outline";
  const text = String(status).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `<span class="badge ${extra}">${esc(label)}: ${esc(text)}</span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
}

function orderCard(transaction) {
  const vendors = transaction.orders
    .map(
      (order) => `
        <div>
          <div class="account-order__vendor-name">
            <span>${esc(order.vendorName || "Vendor")}</span>
            ${statusBadge("Status", order.orderStatus)}
          </div>
          <ul class="order-card__items">
            ${order.items
              .map((item) => `<li><span>${esc(item.name)} &times; ${item.quantity}</span><span>${formatNaira(item.price * item.quantity)}</span></li>`)
              .join("")}
          </ul>
        </div>`
    )
    .join("");

  return `
    <article class="order-card">
      <div class="order-card__header">
        <div>
          <p class="order-card__eyebrow">${esc(formatDate(transaction.createdAt))}</p>
          <h2>${esc(transaction.id)}</h2>
        </div>
        <div class="order-card__statuses">${statusBadge("Payment", transaction.paymentStatus)}</div>
      </div>
      <div class="account-order__vendors">${vendors}</div>
      <div class="order-card__row order-card__row--total"><span>Total</span><span>${formatNaira(transaction.total)}</span></div>
      <div class="order-card__actions">
        <a class="btn btn-outline btn-sm" href="confirmation.html?txn=${encodeURIComponent(transaction.id)}">View details</a>
      </div>
    </article>`;
}

async function onSaveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);
  $("profile-saved").style.display = "none";

  const fullName = $("profile-name").value.trim();
  const phone = $("profile-phone").value.trim();

  let invalid = false;
  if (!fullName || fullName.length > 120) (fieldError("profile-name", "Enter your full name."), (invalid = true));
  if (phone && (!PHONE_RE.test(phone) || phone.length > 30)) (fieldError("profile-phone", "Enter a valid phone number."), (invalid = true));
  if (invalid) return;

  const result = await withBusy($("profile-submit"), "Saving…", () => saveProfile(state.session.user.id, { fullName, phone }));
  if (!result.ok) {
    showError("profile-error", result.error);
    return;
  }
  $("account-greeting").textContent = `Hi, ${fullName.split(" ")[0]}`;
  $("profile-saved").style.display = "block";
}
