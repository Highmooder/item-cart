import { renderHeader, renderFooter } from "../modules/layout.js";
import { finishLoading } from "../modules/loading.js";
import { loadCatalog } from "../modules/catalog.js";
import { escapeHtml, attrUrl } from "../modules/escape.js";
import { getCartSummary, updateQuantity, removeFromCart, MAX_QTY_PER_ITEM } from "../modules/cart.js";
import { formatNaira, withImageFallback } from "../modules/render.js";
import { icon } from "../modules/icons.js";

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("cart.html");
  renderFooter();
  await loadCatalog();
  finishLoading();
  wireCheckoutButton();
  render();
});

function render() {
  const summary = getCartSummary();
  const emptyEl = document.getElementById("cart-empty");
  const layoutEl = document.getElementById("cart-layout");

  if (summary.lines.length === 0) {
    emptyEl.style.display = "block";
    layoutEl.style.display = "none";
    return;
  }

  emptyEl.style.display = "none";
  layoutEl.style.display = "grid";

  renderIssuesBanner(summary);
  renderLines(summary);
  renderTotals(summary);
  wireLineActions();

  const checkoutBtn = document.getElementById("checkout-btn");
  checkoutBtn.disabled = summary.hasIssues || summary.itemCount === 0;
}

function renderIssuesBanner(summary) {
  const el = document.getElementById("cart-issues");
  if (summary.hasIssues) {
    el.style.display = "block";
    el.textContent = "Some items in your cart can't be ordered. Remove them below to continue to checkout.";
  } else {
    el.style.display = "none";
  }
}

function renderLines(summary) {
  const listEl = document.getElementById("cart-items");
  listEl.innerHTML = summary.lines.map(lineTemplate).join("");
  listEl.querySelectorAll("img").forEach(withImageFallback);
}

function lineTemplate(line) {
  if (line.status !== "ok") {
    const message =
      line.status === "unavailable"
        ? "This item is currently unavailable from the vendor."
        : line.status === "service"
          ? "This is a service, so it can't be ordered through the cart. Contact the vendor to arrange it."
          : "This item is no longer in the Item cart catalog.";
    const name = line.product ? line.product.name : "Item unavailable";

    return `
      <div class="cart-line cart-line--issue" data-product-id="${escapeHtml(line.productId)}">
        <span class="cart-line__issue-icon">${icon("close")}</span>
        <div class="cart-line__info">
          <strong class="cart-line__name">${escapeHtml(name)}</strong>
          <span class="cart-line__vendor">${message}</span>
        </div>
        <button type="button" class="btn btn-outline btn-sm" data-action="remove">Remove</button>
      </div>
    `;
  }

  const { product, vendor, quantity, lineTotal, productId } = line;
  return `
    <div class="cart-line" data-product-id="${escapeHtml(productId)}">
      <a class="cart-line__media" href="product.html?id=${encodeURIComponent(product.id)}">
        <img src="${attrUrl(product.image)}" alt="${escapeHtml(product.name)}" />
      </a>
      <div class="cart-line__info">
        <a class="cart-line__name" href="product.html?id=${encodeURIComponent(product.id)}">${escapeHtml(product.name)}</a>
        <span class="cart-line__vendor">${escapeHtml(vendor ? vendor.storeName : "")}</span>
        <span class="cart-line__price">${formatNaira(product.price)} each</span>
      </div>
      <div class="qty-stepper">
        <button type="button" data-action="decrease" aria-label="Decrease quantity" ${quantity <= 1 ? "disabled" : ""}>&minus;</button>
        <span>${quantity}</span>
        <button type="button" data-action="increase" aria-label="Increase quantity" ${quantity >= MAX_QTY_PER_ITEM ? "disabled" : ""}>+</button>
      </div>
      <span class="cart-line__total">${formatNaira(lineTotal)}</span>
      <button type="button" class="icon-btn cart-line__remove" data-action="remove" aria-label="Remove ${escapeHtml(product.name)}">${icon("close")}</button>
    </div>
  `;
}

function renderTotals(summary) {
  document.getElementById("cart-item-count").textContent = String(summary.itemCount);
  document.getElementById("cart-subtotal").textContent = formatNaira(summary.subtotal);
}

function wireLineActions() {
  document.querySelectorAll(".cart-line").forEach((row) => {
    const productId = row.dataset.productId;

    row.querySelector('[data-action="decrease"]')?.addEventListener("click", () => {
      const line = getCartSummary().lines.find((l) => l.productId === productId);
      if (line) updateQuantity(productId, line.quantity - 1);
      render();
    });
    row.querySelector('[data-action="increase"]')?.addEventListener("click", () => {
      const line = getCartSummary().lines.find((l) => l.productId === productId);
      if (line) updateQuantity(productId, line.quantity + 1);
      render();
    });
    row.querySelector('[data-action="remove"]')?.addEventListener("click", () => {
      removeFromCart(productId);
      render();
    });
  });
}

function wireCheckoutButton() {
  const btn = document.getElementById("checkout-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    window.location.href = "checkout.html";
  });
}
