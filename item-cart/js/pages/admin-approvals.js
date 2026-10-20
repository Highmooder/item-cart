import { attrUrl } from "../modules/escape.js";

// WHAT: the "Approvals" tab of the admin dashboard — everything vendors have
// submitted that is waiting for you: new products, and edits to live ones.
// WHY: nothing a vendor posts goes live until you approve it. For an edit you
// see the current version next to the proposed one, so you can spot a
// changed price, name or photo at a glance.
// SECURITY: all of this is checked by the database (admin-only functions in
// 09_vendor_products.sql). Vendor text is untrusted, so it is escaped.
// FUTURE: email yourself when something new is waiting.

const AVAILABILITY = { "in-stock": "Available", limited: "Limited stock", unavailable: "Unavailable" };

export function createApprovalsModule({ supabase, getApprovals, getApprovalsError, getCategories, esc, toast, confirmDialog, friendlyError, refresh, isBusy, setBusy }) {
  const $ = (id) => document.getElementById(id);
  let rejecting = null;

  const naira = (n) => "₦" + Number(n).toLocaleString("en-NG");
  const when = (iso) => new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const categoryName = (id) => getCategories().find((c) => c.id === id)?.name ?? id;

  const thumb = (url, name) =>
    `<span class="approval-thumb">${url ? `<img src="${attrUrl(url)}" alt="" loading="lazy" />` : esc(String(name || "?").trim().charAt(0).toUpperCase())}</span>`;

  // ------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------
  function render() {
    const all = getApprovals();
    $("count-approvals").textContent = all.length || "";
    const el = $("approval-list");

    if (getApprovalsError()) {
      el.innerHTML = `<div class="empty-state"><h3>Vendor products aren't set up yet</h3><p style="margin-inline:auto">Run <code>09_vendor_products.sql</code> in the Supabase SQL editor, then refresh this page.</p></div>`;
      return;
    }
    if (!all.length) {
      el.innerHTML = `<div class="empty-state"><h3>Nothing waiting</h3><p style="margin-inline:auto">New products and edits from vendors appear here for your approval.</p></div>`;
      return;
    }

    el.innerHTML = all.map(card).join("");
  }

  function field(label, from, to) {
    return `<div class="approval-field">
      <span class="approval-label">${esc(label)}</span>
      ${from === null ? "" : `<span class="approval-from">${from}</span><span class="approval-arrow" aria-hidden="true">→</span>`}
      <span class="approval-to">${to}</span>
    </div>`;
  }

  function comparison(item) {
    const c = item.current;
    const p = item.proposed;

    if (item.kind === "new") {
      return `<div class="approval-compare">
        <div class="approval-field"><span class="approval-label">Photo</span><span class="approval-to">${thumb(p.image, p.name)}</span></div>
        ${field("Price", null, esc(naira(p.price)))}
        ${field("Category", null, esc(categoryName(p.categoryId)))}
        ${field("Availability", null, esc(AVAILABILITY[p.availability] || p.availability))}
        ${field("Description", null, `<span class="approval-text">${esc(p.description)}</span>`)}
      </div>`;
    }

    const rows = [];
    if (c.name !== p.name) rows.push(field("Name", `<span class="approval-text">${esc(c.name)}</span>`, `<span class="approval-text">${esc(p.name)}</span>`));
    if (c.price !== p.price) rows.push(field("Price", esc(naira(c.price)), esc(naira(p.price))));
    if (c.categoryId !== p.categoryId) rows.push(field("Category", esc(categoryName(c.categoryId)), esc(categoryName(p.categoryId))));
    if (c.availability !== p.availability) rows.push(field("Availability", esc(AVAILABILITY[c.availability] || c.availability), esc(AVAILABILITY[p.availability] || p.availability)));
    if (c.description !== p.description) rows.push(field("Description", `<span class="approval-text">${esc(c.description)}</span>`, `<span class="approval-text">${esc(p.description)}</span>`));
    if ((c.image || "") !== (p.image || "")) rows.push(field("Photo", thumb(c.image, c.name), thumb(p.image, p.name)));
    return `<div class="approval-compare">${rows.join("") || '<p class="approval-text">No visible changes.</p>'}</div>`;
  }

  function card(item) {
    const key = `${item.productId}|${item.revisionId ?? ""}`;
    return `
    <article class="admin-row admin-row--order">
      <div>
        <div class="admin-row__title">
          <h3>${esc(item.proposed.name)}</h3>
          <span class="badge ${item.kind === "new" ? "badge-accent" : "badge-outline"}">${item.kind === "new" ? "New product" : "Edit to a live product"}</span>
        </div>
        <div class="admin-row__meta"><span>${esc(item.vendorName)}</span><span>Sent ${esc(when(item.submittedAt))}</span></div>
        ${comparison(item)}
      </div>
      <div class="admin-row__actions">
        <button type="button" class="btn btn-primary btn-sm" data-approve="${esc(key)}">Approve</button>
        <button type="button" class="btn btn-danger btn-sm" data-reject="${esc(key)}">Reject</button>
      </div>
    </article>`;
  }

  const find = (key) => getApprovals().find((i) => `${i.productId}|${i.revisionId ?? ""}` === key);

  // ------------------------------------------------------------------
  // Decisions
  // ------------------------------------------------------------------
  async function decide(item, decision, note) {
    if (isBusy()) return false;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_review_product", {
        p_product_id: item.productId,
        p_revision_id: item.revisionId,
        p_decision: decision,
        p_note: note || null,
      });
      if (error) throw error;
      await refresh();
      toast(decision === "approve" ? (item.kind === "new" ? "Approved. It's live in the shop." : "Edit approved. The shop now shows the new version.") : "Rejected. The vendor can see your reason.");
      return true;
    } catch (error) {
      toast(error && error.code === "P0001" ? error.message : friendlyError(error), true);
      await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function approve(key) {
    const item = find(key);
    if (!item) return;
    const ok = await confirmDialog({
      title: item.kind === "new" ? `Approve ${item.proposed.name}?` : `Approve this edit to ${item.current.name}?`,
      body: item.kind === "new" ? "It goes live in the shop straight away." : "The shop switches to the new version straight away.",
      okLabel: "Approve",
      danger: false,
    });
    if (ok) await decide(item, "approve", null);
  }

  function openReject(key) {
    const item = find(key);
    if (!item) return;
    rejecting = item;
    $("reject-title").textContent = item.kind === "new" ? `Reject ${item.proposed.name}?` : `Reject this edit to ${item.current.name}?`;
    $("reject-reason").value = "";
    $("reject-reason").classList.remove("has-error");
    $("reject-reason-error").textContent = "";
    $("reject-error").style.display = "none";
    $("reject-dialog").showModal();
    $("reject-reason").focus();
  }

  async function submitReject(event) {
    event.preventDefault();
    const note = $("reject-reason").value.trim();
    if (note.length < 3) {
      $("reject-reason").classList.add("has-error");
      $("reject-reason-error").textContent = "Give a short reason so the vendor knows what to fix.";
      return;
    }
    const ok = await decide(rejecting, "reject", note);
    if (ok) $("reject-dialog").close();
  }

  function wire() {
    $("approval-list").addEventListener("click", (e) => {
      const a = e.target.closest("[data-approve]");
      if (a) return approve(a.dataset.approve);
      const r = e.target.closest("[data-reject]");
      if (r) openReject(r.dataset.reject);
    });
    $("reject-form").addEventListener("submit", submitReject);
    $("reject-cancel").addEventListener("click", () => $("reject-dialog").close());
  }

  return { render, wire };
}
