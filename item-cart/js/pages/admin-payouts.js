// WHAT: the "Payouts" tab of the admin dashboard: what each vendor is owed,
// a way to record each payout you make, and a history you can correct.
// WHY: customers pay Item cart once; you then pay each vendor. This replaces
// the notebook. It does NOT move money; you pay the vendor yourself, then
// record it here.
// THE RULES (in database/12_payouts_and_refunds.sql): a vendor is owed an
// order only when its payment is Paid and you set the order to Completed;
// cancelled and refunded orders are never owed; a payout can't exceed what
// is owed.
// SECURITY: every read and write is checked by the database (is_admin()).
// This file only asks.
// FUTURE: let vendors see their own balance; automatic transfers.

export function createPayoutsModule({ supabase, getBalances, getBalancesError, esc, toast, confirmDialog, friendlyError, refresh, isBusy, setBusy }) {
  const $ = (id) => document.getElementById(id);
  const naira = (n) => "₦" + Number(n).toLocaleString("en-NG");
  const day = (iso) => new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

  let recordingId = null;
  let historyId = null;

  const hasActivity = (b) => b.earned !== 0 || b.inProgress !== 0 || b.paidOut !== 0;

  // ------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------
  function render() {
    const err = getBalancesError();
    const el = $("payout-list");
    const summary = $("payout-summary");

    if (err) {
      $("count-payouts").textContent = "";
      summary.hidden = true;
      el.innerHTML = `<div class="empty-state"><h3>Payouts aren't set up yet</h3><p style="margin-inline:auto">Run <code>database/12_payouts_and_refunds.sql</code> in the Supabase SQL Editor, then tap Refresh.</p></div>`;
      return;
    }

    const all = getBalances();
    const owedNow = all.filter((b) => b.owed > 0);
    $("count-payouts").textContent = owedNow.length || "";

    const totalOwed = owedNow.reduce((sum, b) => sum + b.owed, 0);
    const totalInProgress = all.reduce((sum, b) => sum + b.inProgress, 0);
    summary.hidden = false;
    summary.innerHTML = `
      <div><span>Owed to vendors now</span><strong>${naira(totalOwed)}</strong></div>
      <div><span>Vendors to pay</span><strong>${owedNow.length}</strong></div>
      <div><span>Still in progress</span><strong>${naira(totalInProgress)}</strong></div>`;

    const q = $("payout-search").value.trim().toLowerCase();
    const filter = $("payout-filter").value;
    const list = all.filter((b) => {
      if (!hasActivity(b)) return false;
      if (filter === "owed" && b.owed === 0) return false;
      return !q || String(b.storeName).toLowerCase().includes(q);
    });

    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><h3>${filter === "owed" ? "Nobody is owed anything" : "No vendor activity yet"}</h3><p style="margin-inline:auto">${
        filter === "owed"
          ? "A vendor appears here once one of their orders is paid and you set it to Completed."
          : "Vendors appear here once they have a paid order."
      }</p></div>`;
      return;
    }

    el.innerHTML = list.map(row).join("");
  }

  function owedBadge(b) {
    if (b.owed > 0) return `<span class="badge badge-accent">Owed ${naira(b.owed)}</span>`;
    if (b.owed < 0) return `<span class="badge badge-danger">Owes Item cart ${naira(-b.owed)}</span>`;
    return `<span class="badge badge-verified">Settled</span>`;
  }

  function row(b) {
    return `
      <article class="admin-row admin-row--payout" data-vendor="${esc(b.vendorId)}">
        <div>
          <div class="admin-row__title"><h3>${esc(b.storeName)}</h3>${owedBadge(b)}</div>
          <div class="admin-row__meta">
            <span>Earned <strong>${naira(b.earned)}</strong> (${b.completedOrders} completed ${b.completedOrders === 1 ? "order" : "orders"})</span>
            <span>Paid out <strong>${naira(b.paidOut)}</strong></span>
            ${b.inProgress ? `<span>In progress ${naira(b.inProgress)}</span>` : ""}
            ${b.lastPayoutAt ? `<span>Last payout ${esc(day(b.lastPayoutAt))}</span>` : ""}
          </div>
        </div>
        <div class="admin-row__actions">
          <button type="button" class="btn btn-primary btn-sm" data-payout-record="${esc(b.vendorId)}" ${b.owed > 0 ? "" : "disabled"}>Record payout</button>
          <button type="button" class="btn btn-outline btn-sm" data-payout-history="${esc(b.vendorId)}">History</button>
        </div>
      </article>`;
  }

  // ------------------------------------------------------------------
  // Record a payout
  // ------------------------------------------------------------------
  function openRecord(vendorId) {
    const b = getBalances().find((x) => x.vendorId === vendorId);
    if (!b || b.owed <= 0) return;
    recordingId = vendorId;
    $("payout-title").textContent = `Record payout: ${b.storeName}`;
    $("payout-owed-text").textContent = `Owed now: ${naira(b.owed)}. Pay the vendor first (bank transfer, cash...), then record it here.`;
    $("payout-amount").value = String(b.owed);
    $("payout-note").value = "";
    $("payout-amount-error").textContent = "";
    $("payout-error").style.display = "none";
    $("payout-dialog").showModal();
    $("payout-amount").focus();
  }

  async function submitRecord(event) {
    event.preventDefault();
    if (isBusy()) return;
    const b = getBalances().find((x) => x.vendorId === recordingId);
    if (!b) return;

    const amount = Number($("payout-amount").value);
    const errorEl = $("payout-amount-error");
    errorEl.textContent = "";
    if (!Number.isInteger(amount) || amount <= 0) {
      errorEl.textContent = "Enter a whole number of naira above 0.";
      return;
    }
    if (amount > b.owed) {
      errorEl.textContent = `That is more than the ${naira(b.owed)} owed.`;
      return;
    }

    setBusy(true);
    $("payout-error").style.display = "none";
    try {
      const { error } = await supabase.rpc("admin_record_payout", { p_vendor_id: b.vendorId, p_amount: amount, p_note: $("payout-note").value });
      if (error) throw error;
      $("payout-dialog").close();
      await refresh();
      toast(`Recorded ${naira(amount)} paid to ${b.storeName}.`);
    } catch (err) {
      $("payout-error").textContent = friendlyError(err);
      $("payout-error").style.display = "block";
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // History (and voiding a mistake)
  // ------------------------------------------------------------------
  async function openHistory(vendorId) {
    historyId = vendorId;
    const b = getBalances().find((x) => x.vendorId === vendorId);
    $("payout-history-title").textContent = `Payouts: ${b ? b.storeName : "vendor"}`;
    $("payout-history-list").innerHTML = "<p>Loading…</p>";
    if (!$("payout-history-dialog").open) $("payout-history-dialog").showModal();
    await loadHistory();
  }

  async function loadHistory() {
    const el = $("payout-history-list");
    const { data, error } = await supabase
      .from("vendor_payouts")
      .select("*")
      .eq("vendor_id", historyId)
      .order("paid_at", { ascending: false })
      .limit(30);
    if (error) {
      el.innerHTML = `<p class="form-submit-error" style="display:block">${esc(friendlyError(error))}</p>`;
      return;
    }
    if (!data.length) {
      el.innerHTML = "<p>No payouts recorded yet.</p>";
      return;
    }
    el.innerHTML = `<ul class="payout-history">${data
      .map(
        (p) => `
        <li class="${p.voided_at ? "is-voided" : ""}">
          <div>
            <strong>${naira(p.amount)}</strong>
            ${p.voided_at ? '<span class="badge badge-outline">Voided</span>' : ""}
            <span class="payout-history__when">${esc(when(p.paid_at))}</span>
            ${p.note ? `<p class="payout-history__note">${esc(p.note)}</p>` : ""}
          </div>
          ${p.voided_at ? "" : `<button type="button" class="btn btn-outline btn-sm" data-payout-void="${esc(p.id)}" data-amount="${esc(p.amount)}">Void</button>`}
        </li>`
      )
      .join("")}</ul>`;
  }

  async function voidPayout(id, amount) {
    if (isBusy()) return;
    const ok = await confirmDialog({
      title: `Void this ${naira(amount)} payout?`,
      body: "Use this only if you recorded it by mistake. The entry stays in the history, marked voided, and the vendor's owed amount goes back up.",
      okLabel: "Void payout",
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_void_payout", { p_payout_id: Number(id) });
      if (error) throw error;
      await refresh();
      await loadHistory();
      toast("Payout voided.");
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wire() {
    $("payout-search").addEventListener("input", render);
    $("payout-filter").addEventListener("change", render);
    $("refresh-payouts-btn").addEventListener("click", async () => {
      if (isBusy()) return;
      setBusy(true);
      try {
        await refresh();
        toast("Payouts refreshed.");
      } finally {
        setBusy(false);
      }
    });

    $("payout-list").addEventListener("click", (e) => {
      const record = e.target.closest("[data-payout-record]");
      if (record) return openRecord(record.dataset.payoutRecord);
      const history = e.target.closest("[data-payout-history]");
      if (history) openHistory(history.dataset.payoutHistory);
    });

    $("payout-form").addEventListener("submit", submitRecord);
    $("payout-cancel").addEventListener("click", () => $("payout-dialog").close());

    $("payout-history-dialog").addEventListener("click", (e) => {
      if (e.target.closest("[data-payout-history-close]")) return $("payout-history-dialog").close();
      const void_ = e.target.closest("[data-payout-void]");
      if (void_) voidPayout(void_.dataset.payoutVoid, void_.dataset.amount);
    });
  }

  return { render, wire };
}
