// WHAT: the chat tools in the admin dashboard — (1) the "Chats" tab, which
// lists messages where someone shared a phone number, and (2) the
// "Logins" dialog that links a vendor's account to their store so they can
// answer messages.
// WHY: the phone number is hidden from the other person automatically.
// This tab is where YOU see the original, spot repeat offenders, and
// decide what to do.
// PRIVACY: you see flagged messages plus the few messages before them for
// context, not every conversation.
// SECURITY: all of this is enforced by the database (admin-only functions
// in 06_chat.sql); this file only asks.
// FUTURE: warn or suspend repeat offenders; link straight to a flagged
// vendor's orders.

export function createChatAdminModule({ supabase, getFlagged, getFlaggedError, getVendor, esc, toast, friendlyError, refresh, isBusy, setBusy }) {
  const $ = (id) => document.getElementById(id);
  let accountsVendorId = null;

  const when = (iso) =>
    new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

  // ------------------------------------------------------------------
  // Flagged messages
  // ------------------------------------------------------------------
  function render() {
    const all = getFlagged();
    $("count-chats").textContent = all.filter((f) => !f.reviewed).length || "";

    const el = $("chat-list");
    if (getFlaggedError()) {
      el.innerHTML = `<div class="empty-state"><h3>Chat isn't set up yet</h3><p style="margin-inline:auto">Run <code>06_chat.sql</code> in the Supabase SQL editor, then refresh this page.</p></div>`;
      return;
    }

    const filter = $("chat-filter").value;
    const list = all.filter((f) => filter === "all" || !f.reviewed);

    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><h3>${filter === "all" ? "Nothing flagged yet" : "Nothing to review"}</h3><p style="margin-inline:auto">${
        filter === "all" ? "Messages where someone shared a phone number appear here." : "Every flagged message has been reviewed."
      }</p></div>`;
      return;
    }

    el.innerHTML = list
      .map((f) => {
        const context = (f.context || [])
          .map((c) => `<li><strong>${c.role === "customer" ? "Customer" : "Vendor"}:</strong> ${esc(c.body)}</li>`)
          .join("");
        return `
        <article class="admin-row admin-row--order">
          <div>
            <div class="admin-row__title">
              <h3>${esc(f.senderName)}</h3>
              <span class="badge badge-outline">${f.senderRole === "customer" ? "Customer" : "Vendor"}</span>
              ${f.reviewed ? '<span class="badge">Reviewed</span>' : '<span class="badge badge-danger">Needs review</span>'}
              ${f.senderFlagCount > 1 ? `<span class="badge badge-accent">${f.senderFlagCount} flags from this person</span>` : ""}
            </div>
            <div class="admin-row__meta">
              <span>Chat with ${esc(f.vendorName)}</span>
              <span>${esc(when(f.createdAt))}</span>
            </div>
            <p class="flag-label">What they wrote</p>
            <p class="flag-original">${esc(f.originalBody)}</p>
            <p class="flag-label">What the other person saw</p>
            <p class="flag-masked">${esc(f.maskedBody)}</p>
            ${context ? `<details class="flag-context"><summary>Earlier messages</summary><ul>${context}</ul></details>` : ""}
          </div>
          <div class="admin-row__actions">
            ${f.reviewed ? "" : `<button type="button" class="btn btn-primary btn-sm" data-flag-review="${esc(f.id)}">Mark reviewed</button>`}
          </div>
        </article>`;
      })
      .join("");
  }

  async function reviewFlag(id) {
    if (isBusy()) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_review_flag", { p_message_id: Number(id) });
      if (error) throw error;
      await refresh();
      toast("Marked as reviewed.");
    } catch (error) {
      toast(friendlyError(error), true);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // Vendor logins
  // ------------------------------------------------------------------
  async function openAccounts(vendorId) {
    const vendor = getVendor(vendorId);
    if (!vendor) return;
    accountsVendorId = vendorId;

    $("accounts-title").textContent = `Logins for ${vendor.store_name}`;
    $("accounts-email").value = "";
    $("accounts-error").style.display = "none";
    $("accounts-list").innerHTML = "<li>Loading…</li>";
    if (!$("accounts-dialog").open) $("accounts-dialog").showModal();
    await loadAccounts();
  }

  async function loadAccounts() {
    const { data, error } = await supabase.rpc("admin_vendor_accounts", { p_vendor_id: accountsVendorId });
    if (error) {
      showAccountsError(friendlyError(error));
      $("accounts-list").innerHTML = "";
      return;
    }
    $("accounts-list").innerHTML = data.length
      ? data
          .map(
            (a) => `<li><span>${esc(a.email)}</span><button type="button" class="btn btn-danger btn-sm" data-unlink="${esc(a.userId)}">Remove</button></li>`
          )
          .join("")
      : '<li class="accounts-empty">No one is linked yet, so this store can\'t answer messages.</li>';
  }

  function showAccountsError(message) {
    const el = $("accounts-error");
    el.textContent = message;
    el.style.display = "block";
  }

  async function linkAccount(event) {
    event.preventDefault();
    if (isBusy()) return;
    $("accounts-error").style.display = "none";

    const email = $("accounts-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAccountsError("Enter the email they used to create their Item cart account.");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_link_vendor_account", { p_vendor_id: accountsVendorId, p_email: email });
      if (error) throw error;
      $("accounts-email").value = "";
      await loadAccounts();
      toast("Account linked. They can now open the store's inbox.");
    } catch (error) {
      showAccountsError(error && error.code === "P0001" ? error.message : friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function unlinkAccount(userId) {
    if (isBusy()) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_unlink_vendor_account", { p_vendor_id: accountsVendorId, p_user_id: userId });
      if (error) throw error;
      await loadAccounts();
      toast("Account removed from this store.");
    } catch (error) {
      showAccountsError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  function wire() {
    $("chat-filter").addEventListener("change", render);
    $("chat-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-flag-review]");
      if (btn) reviewFlag(btn.dataset.flagReview);
    });

    $("accounts-form").addEventListener("submit", linkAccount);
    $("accounts-dialog").addEventListener("click", (e) => {
      if (e.target.closest("[data-accounts-close]")) return $("accounts-dialog").close();
      const unlink = e.target.closest("[data-unlink]");
      if (unlink) unlinkAccount(unlink.dataset.unlink);
    });
  }

  return { render, wire, openAccounts };
}
