import { renderHeader, renderFooter } from "../modules/layout.js";
import { ITEMCART_CONFIG } from "../data/config.js";

// WHAT: fills in the details on the Privacy Policy and Terms of Service pages
// (business name, contact email, date) from js/data/config.js, so you change
// them in ONE place, and shows the "draft" notice until you switch it off.
// Everything is written with textContent / href (never as HTML).

document.addEventListener("DOMContentLoaded", () => {
  renderHeader("");
  renderFooter();

  const legal = ITEMCART_CONFIG.legal || {};

  document.querySelectorAll("[data-legal]").forEach((el) => {
    const value = legal[el.dataset.legal];
    if (value) el.textContent = value;
  });

  document.querySelectorAll("[data-legal-mail]").forEach((el) => {
    const email = legal.contactEmail || "";
    el.textContent = email;
    el.href = email ? `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}` : "#";
  });

  const draft = document.getElementById("legal-draft");
  if (draft) draft.hidden = legal.draft === false;
});
