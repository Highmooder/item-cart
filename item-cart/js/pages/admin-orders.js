// WHAT: the "Orders" tab of the admin dashboard — see every transaction,
// verify payments, track each vendor's order, and message customers and
// vendors on WhatsApp.
// WHY: customers pay Item cart ONCE (the transaction). You confirm that
// payment here, then tell each vendor to prepare their part. Payment
// status lives only on the transaction; fulfillment status lives only on
// each vendor order — the same split as the database.
// SECURITY: every read and write here is checked by the database
// (is_admin() policies in 01_schema.sql). This file only asks.
// ONLINE PAYMENTS: payments made through Paystack mark themselves Paid; this
// screen is where you handle exceptions and REFUND them (the money goes back
// through Paystack; the amount is worked out by the database, never here).
// FUTURE: refunds for payments made by bank transfer stay manual.

const PAYMENT_STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "awaiting_verification", label: "Awaiting verification" },
  { value: "paid", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded" },
];

const ORDER_STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "processing", label: "Processing" },
  { value: "ready", label: "Ready" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const DISPUTE_STATUSES = [
  { value: "none", label: "No dispute" },
  { value: "open", label: "Dispute open" },
  { value: "resolved", label: "Dispute resolved" },
];

const NEEDS_CHECK = ["pending", "awaiting_verification"];
const IN_PROGRESS = ["confirmed", "processing", "ready", "completed"];

const BADGE = {
  paid: "badge-verified",
  completed: "badge-verified",
  pending: "badge-accent",
  awaiting_verification: "badge-accent",
  failed: "badge-danger",
  cancelled: "badge-danger",
  refunded: "badge-outline",
};

const labelOf = (list, value) => list.find((o) => o.value === value)?.label ?? value;

export function createOrdersModule({ supabase, getTransactions, getRefunds = () => [], requestRefund, getVendor, esc, toast, confirmDialog, friendlyError, refresh, isBusy, setBusy }) {
  const $ = (id) => document.getElementById(id);
  let openId = null;

  const naira = (n) => "₦" + Number(n).toLocaleString("en-NG");
  const when = (iso) =>
    new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const badge = (status, list) => `<span class="badge ${BADGE[status] ?? "badge-outline"}">${esc(labelOf(list, status))}</span>`;

  // ---- online refunds ----
  const REFUND_BADGE = { processed: "badge-verified", pending: "badge-accent", processing: "badge-accent", failed: "badge-danger", "needs-attention": "badge-danger" };
  const refundsFor = (txnId) => getRefunds().filter((r) => r.transaction_id === txnId);
  const refundProblem = (txnId) => refundsFor(txnId).some((r) => r.provider_status === "failed" || r.provider_status === "needs-attention");
  // What can still be refunded through Paystack (0 for payments made by hand).
  // (Hidden until 12_payouts_and_refunds.sql has been run: before that the
  // refunded_amount column doesn't exist, so there is nothing to refund with.)
  const refundable = (t) =>
    t.refunded_amount !== undefined && t.payment_provider === "paystack" && t.payment_status === "paid"
      ? Math.max(0, Number(t.total) + Number(t.payment_fee || 0) - Number(t.refunded_amount || 0))
      : 0;

  // Nigerian numbers are often typed as 080... — WhatsApp links need 234...
  function waNumber(raw) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("0")) return "234" + digits.slice(1);
    return digits.length >= 10 ? digits : "";
  }
  const waLink = (raw, text) => {
    const n = waNumber(raw);
    return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : "";
  };

  // ------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------
  function render() {
    const all = getTransactions();
    const needs = all.filter((t) => NEEDS_CHECK.includes(t.payment_status)).length;
    $("count-orders").textContent = needs || "";

    const q = $("order-search").value.trim().toLowerCase();
    const filter = $("order-filter").value;

    let list = all.filter((t) => {
      if (filter === "needs_check" && !NEEDS_CHECK.includes(t.payment_status)) return false;
      if (filter === "paid" && t.payment_status !== "paid") return false;
      if (filter === "problem" && !["failed", "refunded"].includes(t.payment_status)) return false;
      if (!q) return true;
      return [t.id, t.customer_name, t.customer_phone, t.customer_email, ...t.orders.map((o) => o.id)].join(" ").toLowerCase().includes(q);
    });
    // Oldest waiting first, so nobody's payment sits unchecked.
    if (filter === "needs_check") list = [...list].reverse();

    const el = $("order-list");
    $("order-limit-note").hidden = all.length < 200;

    if (!all.length) {
      el.innerHTML = `<div class="empty-state"><h3>No orders yet</h3><p style="margin-inline:auto">Orders placed in the shop will appear here.</p></div>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><h3>${filter === "needs_check" ? "Nothing waiting" : "No matches"}</h3><p style="margin-inline:auto">${
        filter === "needs_check" ? "Every payment has been checked." : "Try a different search or filter."
      }</p></div>`;
      return;
    }

    el.innerHTML = list
      .map((t) => {
        const dispute = t.orders.some((o) => o.dispute_status === "open");
        return `
        <article class="admin-row admin-row--order">
          <div>
            <div class="admin-row__title">
              <h3>${esc(t.id)}</h3>
              ${badge(t.payment_status, PAYMENT_STATUSES)}
              ${dispute ? '<span class="badge badge-danger">Dispute open</span>' : ""}
              ${refundProblem(t.id) ? '<span class="badge badge-danger">Refund needs attention</span>' : ""}
              ${Number(t.refunded_amount) > 0 && t.payment_status === "paid" ? '<span class="badge badge-outline">Partly refunded</span>' : ""}
            </div>
            <div class="admin-row__meta">
              <strong>${naira(t.total)}</strong>
              <span>${esc(t.customer_name)}</span>
              <span>${esc(t.customer_phone)}</span>
              <span>${esc(when(t.created_at))}</span>
              <span>${t.orders.length} ${t.orders.length === 1 ? "vendor order" : "vendor orders"}</span>
              <span>${t.delivery_method === "delivery" ? "Delivery" : "Pickup"}</span>
            </div>
          </div>
          <div class="admin-row__actions">
            <button type="button" class="btn btn-primary btn-sm" data-order-open="${esc(t.id)}">Open</button>
          </div>
        </article>`;
      })
      .join("");
  }

  // ------------------------------------------------------------------
  // Detail dialog
  // ------------------------------------------------------------------
  function openDetail(id) {
    openId = id;
    renderDetail();
    const dlg = $("order-dialog");
    if (!dlg.open) dlg.showModal();
  }

  function select(id, options, value) {
    return `<select id="${id}">${options.map((o) => `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  }

  function renderDetail() {
    const t = getTransactions().find((x) => x.id === openId);
    const el = $("order-detail");
    if (!t) {
      el.innerHTML = `<p>This order could not be found.</p><div class="admin-dialog__actions"><button type="button" class="btn btn-outline" data-order-close>Close</button></div>`;
      return;
    }

    const firstName = String(t.customer_name).trim().split(/\s+/)[0] || "there";
    const customerWa = waLink(t.customer_phone, `Hi ${firstName}, this is Item cart about your order ${t.id}.`);

    const orders = [...t.orders].sort((a, b) => a.id.localeCompare(b.id)).map((o) => orderBlock(t, o)).join("");

    el.innerHTML = `
      <div class="order-detail__head">
        <div>
          <p class="order-detail__eyebrow">${esc(when(t.created_at))}</p>
          <h2 id="order-dialog-title">${esc(t.id)}</h2>
        </div>
        ${badge(t.payment_status, PAYMENT_STATUSES)}
      </div>

      <section class="order-detail__section">
        <h3>Customer</h3>
        <p><strong>${esc(t.customer_name)}</strong></p>
        <p class="order-detail__links">
          <a href="tel:${esc(t.customer_phone)}">${esc(t.customer_phone)}</a>
          ${customerWa ? `<a href="${esc(customerWa)}" target="_blank" rel="noopener">Message on WhatsApp</a>` : ""}
        </p>
        <p>${esc(t.customer_email)}</p>
        <p>${t.delivery_method === "delivery" ? `<strong>Deliver to:</strong> ${esc(t.customer_location || "No location given")}` : "<strong>Pickup</strong> from each vendor"}</p>
        ${t.customer_note ? `<p><strong>Note:</strong> ${esc(t.customer_note)}</p>` : ""}
      </section>

      <section class="order-detail__section">
        <h3>Payment</h3>
        <dl class="order-detail__money">
          <div><dt>Subtotal</dt><dd>${naira(t.subtotal)}</dd></div>
          <div><dt>Delivery fee</dt><dd>${t.delivery_fee ? naira(t.delivery_fee) : "Free"}</dd></div>
          <div class="is-total"><dt>Customer pays Item cart</dt><dd>${naira(t.total)}</dd></div>
          <div><dt>Item cart commission</dt><dd>${naira(t.commission_total)}</dd></div>
          <div><dt>Owed to vendors</dt><dd>${naira(t.vendor_payout_total)}</dd></div>
          ${t.payment_provider === "paystack" && Number(t.payment_fee) > 0 ? `<div><dt>Online fee paid by customer</dt><dd>${naira(t.payment_fee)}</dd></div>` : ""}
          ${Number(t.refunded_amount) > 0 ? `<div><dt>Refunded so far</dt><dd>${naira(t.refunded_amount)}</dd></div>` : ""}
        </dl>
        ${t.payment_provider === "paystack" ? `<p class="order-detail__hint">Paid online with Paystack${t.payment_reference ? ` · reference ${esc(t.payment_reference)}` : ""}.</p>` : ""}
        <div class="order-detail__controls">
          <label for="pay-status" class="visually-hidden">Payment status</label>
          ${select("pay-status", PAYMENT_STATUSES, t.payment_status)}
          <button type="button" class="btn btn-primary btn-sm" data-pay-save="${esc(t.id)}">Update payment</button>
        </div>
        ${refundSection(t)}
      </section>

      <section class="order-detail__section">
        <h3>Vendor orders</h3>
        ${orders || "<p>No vendor orders.</p>"}
      </section>

      <div class="form-submit-error" id="order-error" role="alert"></div>
      <div class="admin-dialog__actions">
        <button type="button" class="btn btn-outline" data-order-close>Close</button>
      </div>`;
  }

  function refundSection(t) {
    const refunds = refundsFor(t.id);
    const left = refundable(t);
    if (!refunds.length && !left) return "";

    const rows = refunds
      .map(
        (r) => `
        <li>
          <span>${naira(r.amount)} · ${r.order_id ? esc(r.order_id) : "everything remaining"} · ${esc(when(r.created_at))}</span>
          <span class="badge ${REFUND_BADGE[r.provider_status] ?? "badge-outline"}">${esc(r.provider_status)}</span>
        </li>`
      )
      .join("");
    const problem = refundProblem(t.id)
      ? `<p class="form-submit-error" style="display:block">Paystack couldn't complete a refund below. The money returns to your Paystack balance, but the customer hasn't received it. Refund them another way (for example bank transfer) and note it on the order.</p>`
      : "";

    return `
      <div class="order-detail__refunds">
        <h4>Online refunds</h4>
        ${rows ? `<ul class="order-detail__refund-list">${rows}</ul>` : ""}
        ${problem}
        ${
          left
            ? `<p class="order-detail__hint">Refunds go back to the customer's original payment method through Paystack. Check Paystack's current terms on whether its own fee is returned.</p>
               <button type="button" class="btn btn-outline btn-sm btn-danger-outline" data-refund-all="${esc(t.id)}">Refund everything remaining (${naira(left)})</button>`
            : ""
        }
      </div>`;
  }

  function orderBlock(t, o) {
    const vendor = getVendor(o.vendor_id);
    const name = vendor ? vendor.store_name : "Vendor";
    const items = [...(o.order_items ?? [])].sort((a, b) => a.id - b.id);

    const lines = items.map((i) => `- ${i.quantity} x ${i.name}`).join("\n");
    const paidLine =
      t.payment_status === "paid"
        ? "Payment is confirmed by Item cart. Please prepare this order and tell us when it's ready."
        : "Payment isn't confirmed yet. Please wait for our go-ahead before preparing.";
    const where = t.delivery_method === "delivery" ? `Deliver to: ${t.customer_location || "to be confirmed"}` : "Customer will pick up.";
    const message = [
      `Hi ${name}, new Item cart order ${o.id}.`,
      "",
      lines,
      "",
      `Customer: ${t.customer_name}, ${t.customer_phone}`,
      where,
      t.customer_note ? `Note: ${t.customer_note}` : "",
      "",
      paidLine,
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
    const vendorWa = waLink(o.vendor_whatsapp || (vendor && vendor.whatsapp), message);
    const rate = Number(o.commission_rate) * 100;

    return `
      <article class="order-detail__order" data-order="${esc(o.id)}">
        <div class="order-detail__order-head">
          <div>
            <p class="order-detail__eyebrow">${esc(name)}</p>
            <h4>${esc(o.id)}</h4>
          </div>
          ${badge(o.order_status, ORDER_STATUSES)}
        </div>
        <ul class="order-detail__items">
          ${items.map((i) => `<li><span>${esc(i.name)} &times; ${i.quantity}</span><span>${naira(i.price * i.quantity)}</span></li>`).join("")}
        </ul>
        <dl class="order-detail__money">
          <div><dt>Vendor subtotal</dt><dd>${naira(o.vendor_subtotal)}</dd></div>
          <div><dt>Commission${rate ? ` (${rate}%)` : ""}</dt><dd>${naira(o.commission_amount)}</dd></div>
          <div class="is-total"><dt>Pay vendor</dt><dd>${naira(o.vendor_payout)}</dd></div>
        </dl>
        <div class="order-detail__controls">
          <label for="status-${esc(o.id)}" class="visually-hidden">Order status</label>
          ${select("status-" + o.id, ORDER_STATUSES, o.order_status)}
          <label for="dispute-${esc(o.id)}" class="visually-hidden">Dispute status</label>
          ${select("dispute-" + o.id, DISPUTE_STATUSES, o.dispute_status)}
          <button type="button" class="btn btn-primary btn-sm" data-order-save="${esc(o.id)}" data-txn="${esc(t.id)}">Save order</button>
          ${
            refundable(t) > 0 && o.order_status !== "cancelled"
              ? `<button type="button" class="btn btn-outline btn-sm btn-danger-outline" data-refund-order="${esc(o.id)}" data-txn="${esc(t.id)}">Refund this order (${naira(Math.min(Number(o.vendor_subtotal), refundable(t)))})</button>`
              : ""
          }
        </div>
        ${vendorWa ? `<p class="order-detail__links"><a href="${esc(vendorWa)}" target="_blank" rel="noopener">Send this order to ${esc(name)} on WhatsApp</a></p>` : ""}
      </article>`;
  }

  // ------------------------------------------------------------------
  // Updates
  // ------------------------------------------------------------------
  function showError(message) {
    const el = $("order-error");
    if (!el) return toast(message, true);
    el.textContent = message;
    el.style.display = "block";
  }

  async function guarded(task) {
    if (isBusy()) return;
    setBusy(true);
    const err = $("order-error");
    if (err) err.style.display = "none";
    try {
      await task();
      await refresh();
      if ($("order-dialog").open) renderDetail();
    } catch (error) {
      showError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function savePayment(txnId) {
    const t = getTransactions().find((x) => x.id === txnId);
    const next = $("pay-status").value;
    if (!t || next === t.payment_status) {
      toast("Payment status is already " + labelOf(PAYMENT_STATUSES, next).toLowerCase() + ".");
      return;
    }

    const inProgress = t.orders.some((o) => IN_PROGRESS.includes(o.order_status));
    const messages = {
      paid: "Confirm that you have received the full amount from this customer.",
      failed: "The customer's payment will be marked as failed.",
      refunded: "The payment will be marked as refunded. Make sure the money has actually been returned.",
      pending: "The payment will go back to pending.",
      awaiting_verification: "The payment will be marked as waiting for you to verify it.",
    };
    const warning =
      (next === "failed" || next === "refunded") && inProgress ? " Some vendor orders are already in progress. You may need to cancel them." : "";

    const ok = await confirmDialog({
      title: `Mark ${t.id} as ${labelOf(PAYMENT_STATUSES, next).toLowerCase()}?`,
      body: messages[next] + warning,
      okLabel: "Update payment",
      danger: next === "failed" || next === "refunded",
    });
    if (!ok) return;

    await guarded(async () => {
      // "and payment_status is still what we saw" stops two admins from
      // overwriting each other's change.
      const { data, error } = await supabase.from("transactions").update({ payment_status: next }).eq("id", t.id).eq("payment_status", t.payment_status).select();
      if (error) throw error;
      if (!data?.length) throw new Error("This order was changed by someone else. It has been refreshed. Try again.");
      toast(`${t.id} marked as ${labelOf(PAYMENT_STATUSES, next).toLowerCase()}.`);
    });
  }

  async function saveOrder(orderId, txnId) {
    const t = getTransactions().find((x) => x.id === txnId);
    const o = t?.orders.find((x) => x.id === orderId);
    if (!o) return;

    const status = $("status-" + orderId).value;
    const dispute = $("dispute-" + orderId).value;
    if (status === o.order_status && dispute === o.dispute_status) {
      toast("Nothing to save. No changes were made.");
      return;
    }

    // Don't block (you may know the money arrived), but make it deliberate.
    if (status !== o.order_status && IN_PROGRESS.includes(status) && t.payment_status !== "paid") {
      const ok = await confirmDialog({
        title: "Payment isn't confirmed yet",
        body: `${t.id} hasn't been marked as paid. Move this order to "${labelOf(ORDER_STATUSES, status).toLowerCase()}" anyway?`,
        okLabel: "Continue",
        danger: false,
      });
      if (!ok) return;
    }

    await guarded(async () => {
      const { data, error } = await supabase
        .from("orders")
        .update({ order_status: status, dispute_status: dispute })
        .eq("id", o.id)
        .eq("order_status", o.order_status)
        .eq("dispute_status", o.dispute_status)
        .select();
      if (error) throw error;
      if (!data?.length) throw new Error("This order was changed by someone else. It has been refreshed. Try again.");
      toast(`${o.id} saved.`);
    });
  }

  // Refund through Paystack. orderId null = everything not yet refunded.
  async function doRefund(txnId, orderId) {
    const t = getTransactions().find((x) => x.id === txnId);
    const o = orderId ? t?.orders.find((x) => x.id === orderId) : null;
    if (!t || (orderId && !o) || isBusy()) return;
    if (typeof requestRefund !== "function") return showError("Online refunds aren't available yet.");

    const left = refundable(t);
    const amount = o ? Math.min(Number(o.vendor_subtotal), left) : left;
    if (amount <= 0) return showError("There is nothing left to refund.");

    const ok = await confirmDialog({
      title: `Refund ${naira(amount)}${o ? ` for ${o.id}` : ` on ${t.id}`}?`,
      body: o
        ? `This sends the items total of ${o.id} back to the customer's original payment method through Paystack, and cancels that vendor order so it is never prepared or paid out. It can't be undone.`
        : `This sends everything not yet refunded back to the customer's original payment method through Paystack, including the online fee they paid, and cancels every remaining vendor order. It can't be undone.`,
      okLabel: `Refund ${naira(amount)}`,
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    const err = $("order-error");
    if (err) err.style.display = "none";
    try {
      const result = await requestRefund(t.id, orderId);
      await refresh(); // always: even after an error the records may have changed
      if ($("order-dialog").open) renderDetail();
      if (!result.ok) return showError(result.message);
      toast(`Refunded ${naira(result.amount)}. Paystack reports it as ${result.providerStatus}.`);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wire() {
    $("order-search").addEventListener("input", render);
    $("order-filter").addEventListener("change", render);
    $("refresh-orders-btn").addEventListener("click", async () => {
      if (isBusy()) return;
      setBusy(true);
      try {
        await refresh();
        toast("Orders refreshed.");
      } finally {
        setBusy(false);
      }
    });

    $("order-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-order-open]");
      if (btn) openDetail(btn.dataset.orderOpen);
    });

    $("order-dialog").addEventListener("click", (e) => {
      if (e.target.closest("[data-order-close]")) return $("order-dialog").close();
      const pay = e.target.closest("[data-pay-save]");
      if (pay) return savePayment(pay.dataset.paySave);
      const ord = e.target.closest("[data-order-save]");
      if (ord) return saveOrder(ord.dataset.orderSave, ord.dataset.txn);
      const refundOrder = e.target.closest("[data-refund-order]");
      if (refundOrder) return doRefund(refundOrder.dataset.txn, refundOrder.dataset.refundOrder);
      const refundAll = e.target.closest("[data-refund-all]");
      if (refundAll) return doRefund(refundAll.dataset.refundAll, null);
    });

    $("order-dialog").addEventListener("close", () => {
      openId = null;
    });
  }

  return { render, wire };
}
