import { renderHeader, renderFooter } from "../modules/layout.js";
import { finishLoading } from "../modules/loading.js";
import { loadCatalog } from "../modules/catalog.js";
import { getSupabase, isBackendConfigured } from "../modules/backend.js";
import { getSession, claimOrder, rememberGuestCheckout } from "../modules/auth.js";
import { getVendorById } from "../data/vendors.js";
import { formatNaira } from "../modules/render.js";
import { escapeHtml as esc } from "../modules/escape.js";
import { ITEMCART_CONFIG } from "../data/config.js";
import { computeOnlineCharge, startOnlinePayment, verifyOnlinePayment } from "../modules/payments.js";

// Extra badge class per status — falls back to a neutral outline for
// any status this page doesn't explicitly recognize, so a future
// admin phase can introduce new statuses without breaking this view.
const STATUS_STYLES = {
  pending: "badge-outline",
  awaiting_verification: "badge-accent",
  paid: "",
  failed: "badge-danger",
  refunded: "badge-danger",
  confirmed: "",
  processing: "badge-accent",
  ready: "badge-accent",
  completed: "",
  cancelled: "badge-danger",
};

// The phone number that proves this is the customer's order (null when signed
// in as the owner). Needed to ask the server about an online payment.
let currentPhone = null;

function onlineEnabled() {
  return Boolean(ITEMCART_CONFIG.onlinePayments && ITEMCART_CONFIG.onlinePayments.enabled);
}

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("cart.html");
  renderFooter();
  await loadCatalog();

  const params = new URLSearchParams(window.location.search);
  const transactionId = params.get("txn");

  if (!transactionId || !isBackendConfigured) {
    showMissing();
    return;
  }

  // Straight after checkout this browser tab already knows the phone
  // number. Anyone opening the link later is asked for it — transaction
  // ids are guessable, so the phone number is what proves it's their order.
  // Signed-in customers can open their own orders without a phone number.
  const session = await getSession();
  const remembered = readRemembered(transactionId);
  currentPhone = remembered;
  const transaction = remembered
    ? await fetchConfirmation(transactionId, remembered)
    : session
      ? await fetchConfirmation(transactionId, null)
      : null;

  if (transaction) {
    showTransaction(transaction, session);
    return;
  }
  showLookup(transactionId, session);
});

function readRemembered(transactionId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem("item_cart_last_checkout") || "null");
    return saved && saved.transactionId === transactionId ? saved.phone : null;
  } catch (error) {
    return null;
  }
}

// Returns the transaction (with its orders), or null if the phone
// number doesn't match / the order doesn't exist.
async function fetchConfirmation(transactionId, phone) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc("get_confirmation", { p_transaction_id: transactionId, p_phone: phone });
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn("Item cart: could not load the order.", error);
    return undefined;
  }
}

function showMissing() {
  finishLoading();
  document.getElementById("confirmation-lookup").style.display = "none";
  document.getElementById("confirmation-missing").style.display = "block";
  document.title = "Order not found — Item cart";
}

function showTransaction(transaction, session) {
  finishLoading();
  document.getElementById("confirmation-lookup").style.display = "none";
  document.getElementById("confirmation-found").style.display = "block";
  document.title = `Order ${transaction.id} — Item cart`;
  renderTransaction(transaction, transaction.orders);
  renderOrders(transaction.orders);
  renderAccountPrompt(transaction, session);
  handlePaymentReturn(transaction, session);
}

// WHAT: tells the customer where this order lives, and how to keep it.
// - already in their account: link to their order history
// - signed in but the order is a guest order: one tap saves it
// - not signed in: invite them to create an account
function renderAccountPrompt(transaction, session) {
  const el = document.getElementById("confirmation-account");
  const next = encodeURIComponent(`confirmation.html?txn=${transaction.id}`);

  if (transaction.isMine) {
    el.innerHTML = `<p>This order is saved to your account.</p><a class="btn btn-outline btn-sm" href="account.html">View all my orders</a>`;
  } else if (transaction.userLinked) {
    return;
  } else if (session) {
    el.innerHTML = `<p>Save this order to your account so it's always in your history.</p><button type="button" class="btn btn-primary btn-sm" id="claim-btn">Save to my account</button><span class="field-error" id="claim-error"></span>`;
    document.getElementById("claim-btn").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const ok = await claimOrder(transaction.id, transaction.customer.phone);
      if (ok) {
        el.innerHTML = `<p>Saved to your account.</p><a class="btn btn-outline btn-sm" href="account.html">View all my orders</a>`;
      } else {
        button.disabled = false;
        document.getElementById("claim-error").textContent = "We couldn't save this order. Please try again.";
      }
    });
  } else {
    // Remember it in this browser, so it's added automatically once they
    // create or sign in to an account.
    rememberGuestCheckout(transaction.id, transaction.customer.phone);
    el.innerHTML = `
      <p>Don't lose this order. Create a free account and it will always be in your order history.</p>
      <div class="account-prompt__actions">
        <a class="btn btn-primary btn-sm" href="account.html?tab=signup&next=${next}">Create account</a>
        <a class="btn btn-outline btn-sm" href="account.html?next=${next}">Sign in</a>
      </div>`;
  }
  el.style.display = "block";
}

function showLookup(transactionId, session) {
  finishLoading();
  document.getElementById("confirmation-lookup").style.display = "block";
  document.title = "Find your order — Item cart";

  const form = document.getElementById("lookup-form");
  const input = document.getElementById("lookup-phone");
  const errorEl = document.getElementById("lookup-error");
  const button = document.getElementById("lookup-submit");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.textContent = "";
    const phone = input.value.trim();
    if (!/^[0-9+()\-\s]{7,}$/.test(phone)) {
      errorEl.textContent = "Enter the phone number you used at checkout.";
      return;
    }

    button.disabled = true;
    const transaction = await fetchConfirmation(transactionId, phone);
    button.disabled = false;

    if (transaction === undefined) {
      errorEl.textContent = "We couldn't reach the server. Check your connection and try again.";
    } else if (!transaction) {
      errorEl.textContent = "That phone number doesn't match this order.";
    } else {
      currentPhone = phone;
      showTransaction(transaction, session);
    }
  });
}

// ---------------------------------------------------------------------
// Online payment: coming back from Paystack, and paying again
// ---------------------------------------------------------------------
// WHAT: after paying, Paystack sends the customer back here. The page asks
// the server to check with Paystack (the server, not this page, marks the
// order paid) and refreshes when it is. If Paystack's message is slow, the
// page keeps asking for about 25 seconds and then explains what to do.
const PAY_NOTES = {
  not_configured: "Online payment isn't available right now. Please pay by bank transfer below.",
  slow_down: "Please wait a moment and try again.",
  network: "We couldn't reach the payment service. Check your connection and try again, or pay by bank transfer below.",
  failed: "We saved your order, but couldn't open the payment page. Try \"Pay online\" again, or pay by bank transfer below.",
};

function showBanner(kind, message, actionLabel, onAction) {
  const el = document.getElementById("payment-banner");
  el.className = `payment-banner payment-banner--${kind}`;
  el.textContent = message;
  if (actionLabel) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline btn-sm";
    button.textContent = actionLabel;
    button.addEventListener("click", onAction);
    el.appendChild(button);
  }
  el.style.display = "block";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reloadAfterPayment(transactionId) {
  const fresh = await fetchConfirmation(transactionId, currentPhone);
  if (fresh) {
    renderTransaction(fresh, fresh.orders);
    renderOrders(fresh.orders);
  }
}

async function confirmReturnedPayment(transaction) {
  showBanner("info", "Confirming your payment…");
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await verifyOnlinePayment({ transactionId: transaction.id, phone: currentPhone });
    if (result.ok && result.status === "paid") {
      await reloadAfterPayment(transaction.id);
      showBanner("success", "Payment received. Thank you! Your vendors can now start preparing your order.");
      return;
    }
    if (result.ok && result.status === "review") {
      showBanner("info", "We received your payment and are checking it. Item cart will confirm shortly. Please don't pay again.");
      return;
    }
    if (!result.ok && result.code === "not_configured") break;
    await sleep(3000);
  }
  showBanner(
    "info",
    "We haven't had confirmation yet. If you were charged, this will update shortly, so please don't pay twice.",
    "Check again",
    () => confirmReturnedPayment(transaction)
  );
}

function handlePaymentReturn(transaction, session) {
  const params = new URLSearchParams(window.location.search);
  const returning = params.has("reference") || params.has("trxref");
  const note = params.get("paynote");

  if (transaction.paymentStatus === "paid") {
    if (returning) showBanner("success", "Payment received. Thank you! Your vendors can now start preparing your order.");
    return;
  }
  if (note) showBanner("warn", PAY_NOTES[note] || PAY_NOTES.failed);
  if (returning && onlineEnabled()) confirmReturnedPayment(transaction);
}

function wirePayOnline(transaction) {
  const button = document.getElementById("pay-online-btn");
  if (!button) return;
  button.addEventListener("click", async () => {
    const errorEl = document.getElementById("pay-online-error");
    errorEl.textContent = "";
    button.disabled = true;
    const idle = button.textContent;
    button.textContent = "Opening secure payment…";
    const started = await startOnlinePayment({ transactionId: transaction.id, phone: currentPhone });
    if (started.ok) {
      window.location.href = started.authorizationUrl;
      return;
    }
    if (started.code === "already_paid") {
      await reloadAfterPayment(transaction.id);
      showBanner("success", "This order is already paid. Thank you!");
      return;
    }
    errorEl.textContent = PAY_NOTES[started.code] || PAY_NOTES.failed;
    button.disabled = false;
    button.textContent = idle;
  });
}

// The transaction is the customer's ONE payment: one amount, one
// payment status, one set of payment instructions, one receipt-upload
// action. Vendor orders (rendered separately below) never repeat any
// of this — they show fulfillment detail only.
function renderTransaction(transaction, orders) {
  const el = document.getElementById("confirmation-transaction");
  const deliveryLabel = transaction.deliveryMethod === "delivery" ? "Delivery fee" : "Pickup";

  const paid = transaction.paymentStatus === "paid";
  const paidOnline = paid && transaction.paymentProvider === "paystack";
  const onlineFee = paidOnline ? Number(transaction.paymentFee) || 0 : 0;
  const refunded = Number(transaction.refundedAmount) || 0;
  const canPayOnline = onlineEnabled() && (transaction.paymentStatus === "pending" || transaction.paymentStatus === "failed");
  const online = canPayOnline ? computeOnlineCharge(transaction.total) : null;

  const totalLabel = paid ? "Amount paid" : "Amount to pay Item cart";
  const totalValue = paidOnline ? transaction.total + onlineFee : transaction.total;

  const payOnlineBox = canPayOnline
    ? `
      <div class="pay-online">
        <h3>Pay online now</h3>
        <p>Bank transfer, USSD or card, confirmed instantly. The online fee is ${formatNaira(online.fee)}; it goes to our payment provider (Paystack), not to Item cart. You pay ${formatNaira(online.charge)}.</p>
        <button type="button" class="btn btn-primary" id="pay-online-btn">Pay online · ${formatNaira(online.charge)}</button>
        <span class="field-error" id="pay-online-error"></span>
        <p class="pay-online__or">Prefer no fee? Pay by bank transfer instead, below.</p>
      </div>`
    : "";

  const manualBlock = paid
    ? `<p class="payment-received">Payment received. Thank you!</p>`
    : `
      <div class="payment-instructions">
        <h3>How to pay</h3>
        <p class="payment-instructions__note">${ITEMCART_CONFIG.paymentInstructions.note}</p>
        <dl>
          <div><dt>Bank</dt><dd>${ITEMCART_CONFIG.paymentInstructions.bankName}</dd></div>
          <div><dt>Account name</dt><dd>${ITEMCART_CONFIG.paymentInstructions.accountName}</dd></div>
          <div><dt>Account number</dt><dd class="copyable"><span id="account-number-value">${ITEMCART_CONFIG.paymentInstructions.accountNumber}</span><button type="button" class="btn btn-outline btn-sm copy-btn" id="copy-account-btn" aria-label="Copy account number">Copy</button></dd></div>
        </dl>
        <p class="payment-instructions__note">Pay the full amount above to Item cart in one payment — not to individual vendors.</p>
      </div>

      <div class="order-card__actions">
        <a class="btn btn-accent" href="${receiptChatLink(transaction)}">Upload receipt to Item cart Admin</a>
      </div>`;

  el.innerHTML = `
    <article class="order-card">
      <div class="order-card__header">
        <div>
          <p class="order-card__eyebrow">Transaction ID</p>
          <h2>${esc(transaction.id)}</h2>
        </div>
        <div class="order-card__statuses">
          ${statusBadge("Payment", transaction.paymentStatus)}
        </div>
      </div>

      <div class="order-card__row"><span>Subtotal</span><span>${formatNaira(transaction.subtotal)}</span></div>
      <div class="order-card__row"><span>${deliveryLabel}</span><span>${transaction.deliveryFee ? formatNaira(transaction.deliveryFee) : "Free"}</span></div>
      ${onlineFee ? `<div class="order-card__row"><span>Online payment fee</span><span>${formatNaira(onlineFee)}</span></div>` : ""}
      <div class="order-card__row order-card__row--total"><span>${totalLabel}</span><span>${formatNaira(totalValue)}</span></div>
      ${refunded ? `<div class="order-card__row"><span>Refunded to you</span><span>${formatNaira(refunded)}</span></div>` : ""}

      <div class="order-card__meta">
        <p><strong>${transaction.deliveryMethod === "delivery" ? "Delivery to" : "Pickup"}:</strong> ${
    transaction.deliveryMethod === "delivery" ? esc(transaction.customer.location || "Not provided") : "Arranged with each vendor"
  }</p>
        <p><strong>Customer:</strong> ${esc(transaction.customer.name)} · ${esc(transaction.customer.phone)} · ${esc(transaction.customer.email)}</p>
        ${transaction.customer.note ? `<p><strong>Note:</strong> ${esc(transaction.customer.note)}</p>` : ""}
      </div>

      ${payOnlineBox}
      ${manualBlock}
    </article>
  `;

  // Once paid, the page should stop telling the customer to follow payment instructions.
  const lead = document.querySelector("#confirmation-found .confirmation-header p");
  if (lead && paid) lead.textContent = "Your payment is confirmed and your order is with Item cart.";

  wirePayOnline(transaction);
  wireCopyAccount();
}

// Opens the Messages chat with Item cart Admin, ready for the receipt. The
// transaction id travels in the link so the first message can mention it.
function receiptChatLink(transaction) {
  return `messages.html?vendor=${encodeURIComponent(ITEMCART_CONFIG.supportVendorId)}&receipt=${encodeURIComponent(transaction.id)}`;
}

// Copies the account number so it can be pasted straight into a bank app.
function wireCopyAccount() {
  const button = document.getElementById("copy-account-btn");
  const value = document.getElementById("account-number-value");
  if (!button || !value) return;
  const number = value.textContent.trim();

  button.addEventListener("click", async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(number);
      copied = true;
    } catch (error) {
      // Older browsers: select the text and use the classic copy command.
      try {
        const range = document.createRange();
        range.selectNodeContents(value);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copied = document.execCommand("copy");
        selection.removeAllRanges();
      } catch (fallbackError) {
        copied = false;
      }
    }
    button.textContent = copied ? "Copied!" : "Press and hold to copy";
    setTimeout(() => (button.textContent = "Copy"), 2000);
  });
}

// Vendor orders are fulfillment context underneath the transaction —
// no payment status, no payment instructions, and no separate
// receipt action here. Just what each vendor is preparing.
function renderOrders(orders) {
  const container = document.getElementById("confirmation-orders");
  container.innerHTML = orders.map(orderCard).join("");
}

function orderCard(order) {
  const vendor = getVendorById(order.vendorId);

  return `
    <article class="order-card">
      <div class="order-card__header">
        <div>
          <p class="order-card__eyebrow">${esc(order.vendorName || (vendor ? vendor.storeName : "Vendor"))}</p>
          <h2>${esc(order.id)}</h2>
        </div>
        <div class="order-card__statuses">
          ${statusBadge("Status", order.orderStatus)}
        </div>
      </div>

      <ul class="order-card__items">
        ${order.items
          .map(
            (item) => `
              <li>
                <span>${esc(item.name)} &times; ${item.quantity}</span>
                <span>${formatNaira(item.price * item.quantity)}</span>
              </li>
            `
          )
          .join("")}
      </ul>

      <div class="order-card__row order-card__row--total"><span>Vendor subtotal</span><span>${formatNaira(order.vendorSubtotal)}</span></div>
    </article>
  `;
}

function statusBadge(label, status) {
  const extra = STATUS_STYLES[status] ?? "badge-outline";
  const text = String(status).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `<span class="badge ${extra}">${label}: ${text}</span>`;
}
