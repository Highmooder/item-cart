import { renderHeader, renderFooter } from "../modules/layout.js";
import { finishLoading } from "../modules/loading.js";
import { getCartSummary, groupCartByVendor, clearCart } from "../modules/cart.js";
import { loadCatalog } from "../modules/catalog.js";
import { escapeHtml } from "../modules/escape.js";
import { getSupabase, isBackendConfigured } from "../modules/backend.js";
import { getSession, getProfile, rememberGuestCheckout } from "../modules/auth.js";
import { formatNaira } from "../modules/render.js";
import { ITEMCART_CONFIG } from "../data/config.js";
import { getCurrentSchool } from "../data/schools.js";
import { computeOnlineCharge, startOnlinePayment } from "../modules/payments.js";

const GUARD_IDS = ["checkout-empty", "checkout-issues", "checkout-form-wrap"];

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("cart.html");
  renderFooter();
  await loadCatalog();
  finishLoading();
  init();
});

function init() {
  const summary = getCartSummary();

  if (summary.itemCount === 0) {
    showState("checkout-empty");
    return;
  }
  if (summary.hasIssues) {
    showState("checkout-issues");
    return;
  }

  showState("checkout-form-wrap");
  wireDeliveryToggle();
  wirePaymentChoice();
  wireForm();
  renderSummary();
  setUpAccount();
}

// ---------------------------------------------------------------------
// Online payment choice (only when ITEMCART_CONFIG.onlinePayments.enabled)
// ---------------------------------------------------------------------
// The student sees the exact fee BEFORE choosing. The server works the real
// amount out again from the database when the payment starts, so this
// number is only a preview that uses the same formula.
function onlinePaymentsEnabled() {
  return Boolean(ITEMCART_CONFIG.onlinePayments && ITEMCART_CONFIG.onlinePayments.enabled) && isBackendConfigured;
}

function getSelectedPaymentMethod() {
  if (!onlinePaymentsEnabled()) return "manual";
  const checked = document.querySelector('input[name="paymentMethod"]:checked');
  return checked ? checked.value : "manual";
}

function wirePaymentChoice() {
  if (!onlinePaymentsEnabled()) return;
  document.getElementById("payment-field").style.display = "";
  document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => radio.addEventListener("change", renderSummary));
}

// WHAT: if the customer is signed in, fill in their details and tell them
// the order will be saved to their account; if not, invite them to sign
// in. Guest checkout stays fully available.
// WHY: the order is linked to the account by the database (it reads the
// signed-in user itself), so nothing here can be faked from the browser.
async function setUpAccount() {
  const note = document.getElementById("checkout-account-note");
  if (!note || !isBackendConfigured) return;

  const session = await getSession();
  if (!session) {
    note.innerHTML = 'Have an account? <a href="account.html?next=checkout.html">Sign in</a> to save this order to your history, or <a href="account.html?tab=signup&next=checkout.html">create one</a>.';
    note.style.display = "block";
    return;
  }

  const profile = await getProfile(session.user.id);
  const fill = (id, value) => {
    const input = document.getElementById(id);
    if (input && !input.value && value) input.value = value;
  };
  fill("name-input", (profile && profile.full_name) || (session.user.user_metadata && session.user.user_metadata.full_name));
  fill("phone-input", (profile && profile.phone) || (session.user.user_metadata && session.user.user_metadata.phone));
  fill("email-input", session.user.email);

  note.textContent = "Signed in. This order will be saved to your account.";
  note.style.display = "block";
}

function showState(idToShow) {
  GUARD_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === idToShow ? (id === "checkout-form-wrap" ? "grid" : "block") : "none";
  });
}

function getSelectedDeliveryMethod() {
  const checked = document.querySelector('input[name="deliveryMethod"]:checked');
  return checked ? checked.value : "pickup";
}

function wireDeliveryToggle() {
  const radios = document.querySelectorAll('input[name="deliveryMethod"]');
  const locationField = document.getElementById("location-field");
  const locationInput = document.getElementById("location-input");

  function update() {
    const isDelivery = getSelectedDeliveryMethod() === "delivery";
    locationField.style.display = isDelivery ? "block" : "none";
    locationInput.required = isDelivery;
    renderSummary();
  }

  radios.forEach((radio) => radio.addEventListener("change", update));
  update();
}

function renderSummary() {
  const groups = groupCartByVendor();
  const deliveryMethod = getSelectedDeliveryMethod();
  const summaryEl = document.getElementById("checkout-summary-groups");
  const multiNote = document.getElementById("checkout-multivendor-note");

  const overallSubtotal = groups.reduce((sum, g) => sum + g.subtotal, 0);
  const deliveryFee = deliveryMethod === "delivery" ? ITEMCART_CONFIG.deliveryFee : 0;
  const overallTotal = overallSubtotal + deliveryFee;

  // Each vendor group shows only its items and vendor subtotal — this
  // is fulfillment/accounting context, not a separate bill. Delivery
  // fee and the grand total are computed once, below, for the whole
  // cart — applying delivery per vendor here was the double-counting
  // bug this fix corrects.
  summaryEl.innerHTML = groups
    .map(
      (group) => `
        <div class="checkout-vendor-group">
          <h3>${escapeHtml(group.vendor ? group.vendor.storeName : "Vendor")}</h3>
          <ul class="checkout-line-list">
            ${group.lines
              .map((l) => `<li><span>${escapeHtml(l.product.name)} &times; ${l.quantity}</span><span>${formatNaira(l.lineTotal)}</span></li>`)
              .join("")}
          </ul>
          <div class="checkout-row"><span>Vendor subtotal</span><span>${formatNaira(group.subtotal)}</span></div>
        </div>
      `
    )
    .join("");

  document.getElementById("checkout-delivery-label").textContent = deliveryMethod === "delivery" ? "Delivery fee" : "Pickup fee";
  document.getElementById("checkout-overall-subtotal").textContent = formatNaira(overallSubtotal);
  document.getElementById("checkout-overall-delivery").textContent = deliveryFee ? formatNaira(deliveryFee) : "Free";
  multiNote.style.display = groups.length > 1 ? "block" : "none";

  // Online payment: show the fee and what the student will actually be charged.
  let payable = overallTotal;
  const feeRow = document.getElementById("checkout-fee-row");
  const submitBtn = document.querySelector('#checkout-form button[type="submit"]');
  if (onlinePaymentsEnabled()) {
    const { charge, fee } = computeOnlineCharge(overallTotal);
    const online = getSelectedPaymentMethod() === "online";
    document.getElementById("payment-online-hint").textContent = `Bank transfer, USSD or card. Fee: ${formatNaira(fee)}. Confirmed instantly.`;
    document.getElementById("payment-fee-note").textContent = online
      ? `You pay ${formatNaira(fee)} extra for secure online payment. It goes to our payment provider (Paystack), not to Item cart. Choose bank transfer above to avoid it.`
      : "";
    feeRow.style.display = online ? "" : "none";
    document.getElementById("checkout-overall-fee").textContent = formatNaira(fee);
    if (online) payable = charge;
    if (submitBtn && !submitBtn.disabled) submitBtn.textContent = online ? `Place order & pay ${formatNaira(payable)}` : "Place Order";
  } else {
    feeRow.style.display = "none";
  }
  document.getElementById("checkout-grand-total").textContent = formatNaira(payable);
}

function wireForm() {
  const form = document.getElementById("checkout-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearErrors();
    hideSubmitError();

    const values = {
      name: form.name.value.trim(),
      phone: form.phone.value.trim(),
      email: form.email.value.trim(),
      deliveryMethod: getSelectedDeliveryMethod(),
      location: form.location ? form.location.value.trim() : "",
      note: form.note.value.trim(),
    };

    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      showErrors(errors);
      return;
    }

    submitOrder(values, form);
  });
}

function validate(values) {
  const errors = {};
  if (!values.name) errors.name = "Full name is required.";
  if (!/^[0-9+()\-\s]{7,}$/.test(values.phone)) errors.phone = "Enter a valid phone number.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = "Enter a valid email address.";
  if (values.deliveryMethod === "delivery" && !values.location) {
    errors.location = "Delivery location is required.";
  }
  return errors;
}

function clearErrors() {
  document.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  document.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
}

function showErrors(errors) {
  Object.entries(errors).forEach(([field, message]) => {
    const errorEl = document.getElementById(`${field}-error`);
    const inputEl = document.getElementById(`${field}-input`);
    if (errorEl) errorEl.textContent = message;
    if (inputEl) inputEl.classList.add("has-error");
  });
  const firstField = Object.keys(errors)[0];
  document.getElementById(`${firstField}-input`)?.focus();
}

function showSubmitError(message) {
  const el = document.getElementById("checkout-submit-error");
  el.textContent = message;
  el.style.display = "block";
}

function hideSubmitError() {
  const el = document.getElementById("checkout-submit-error");
  el.style.display = "none";
}

// WHAT: sends the whole order to Supabase in ONE call (create_checkout).
// WHY: the database creates the transaction, every vendor order and all
// items together — all or nothing — and works out prices, delivery fee
// and commission itself. Nothing the browser sends about money is
// trusted, which is why only product ids and quantities go up.
async function submitOrder(values, form) {
  const school = getCurrentSchool();
  const submitBtn = form.querySelector('button[type="submit"]');
  const idleLabel = submitBtn.textContent;

  if (!isBackendConfigured) {
    showSubmitError("Ordering isn't available yet. Please try again soon.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Placing order…";

  const items = groupCartByVendor().flatMap((group) =>
    group.lines.map((l) => ({ productId: l.product.id, quantity: l.quantity }))
  );

  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc("create_checkout", {
      p_school_id: school ? school.id : null,
      p_customer: {
        name: values.name,
        phone: values.phone,
        email: values.email,
        location: values.location,
        note: values.note,
      },
      p_delivery_method: values.deliveryMethod,
      p_items: items,
    });

    if (error) throw error;
    const payOnline = getSelectedPaymentMethod() === "online";

    // The confirmation page needs the phone number to look the order up
    // (guests have no login). Kept for this browser tab only.
    try {
      sessionStorage.setItem("item_cart_last_checkout", JSON.stringify({ transactionId: data.transactionId, phone: values.phone }));
    } catch (storageError) {
      console.warn("Item cart: could not remember the checkout for this tab.", storageError);
    }

    // A guest's order is remembered so it can be saved to an account if
    // they create or sign in to one next.
    const session = await getSession();
    if (!session) rememberGuestCheckout(data.transactionId, values.phone);

    // The order now exists, so the cart is done whatever happens next.
    clearCart();

    if (payOnline) {
      submitBtn.textContent = "Opening secure payment…";
      const started = await startOnlinePayment({ transactionId: data.transactionId, phone: values.phone });
      if (started.ok) {
        window.location.href = started.authorizationUrl;
        return;
      }
      // The order is saved. The confirmation page explains and offers "Pay online" again.
      window.location.href = `confirmation.html?txn=${encodeURIComponent(data.transactionId)}&paynote=${encodeURIComponent(started.code || "failed")}`;
      return;
    }

    window.location.href = `confirmation.html?txn=${encodeURIComponent(data.transactionId)}`;
  } catch (error) {
    console.warn("Item cart: checkout failed.", error);
    // P0001 = a message we wrote on purpose in the database function
    // (empty cart, item unavailable, invalid phone...), safe to show.
    const message =
      error && error.code === "P0001" && error.message
        ? error.message
        : "We couldn't place your order. Check your internet connection and try again.";
    showSubmitError(message);
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
  }
}
