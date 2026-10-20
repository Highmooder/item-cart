import { renderHeader, renderFooter } from "../modules/layout.js";
import { finishLoading } from "../modules/loading.js";
import { loadCatalog } from "../modules/catalog.js";
import { getProductById, products } from "../data/products.js";
import { getVendorById } from "../data/vendors.js";
import { getCategoryById } from "../data/categories.js";
import {
  formatNaira,
  availabilityBadge,
  withImageFallback,
  renderList,
  productCard,
} from "../modules/render.js";
import { addToCart, wireAddToCartButtons } from "../modules/cart.js";
import { getRelatedProducts } from "../modules/search.js";
import { icon } from "../modules/icons.js";
import { escapeHtml, attrUrl } from "../modules/escape.js";
import { isServiceProduct, contactVendorUrl } from "../modules/services.js";

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("marketplace.html");
  renderFooter();
  await loadCatalog();
  finishLoading();

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const product = id ? getProductById(id) : null;

  if (!product) {
    showMissingState();
    return;
  }

  renderProduct(product);
  renderRelated(product);
});

// No id in the URL, or an id that doesn't match any product — show a
// clear message and a way back, instead of a blank or broken page.
function showMissingState() {
  const missing = document.getElementById("product-missing");
  if (missing) missing.style.display = "block";
  document.title = "Product not found — Item cart";
}

function renderProduct(product) {
  const vendor = getVendorById(product.vendorId);
  const category = getCategoryById(product.categoryId);
  const isAvailable = product.availability !== "unavailable";
  const isService = isServiceProduct(product);
  document.title = `${product.name} — Item cart`;

  const detail = document.getElementById("product-detail");
  if (!detail) return;
  detail.style.display = "grid";

  detail.innerHTML = `
    <div class="product-detail__media">
      <img src="${attrUrl(product.image)}" alt="${escapeHtml(product.name)}" />
    </div>
    <div class="product-detail__info">
      <p class="product-detail__breadcrumb">
        <a href="marketplace.html">Marketplace</a> /
        <a href="marketplace.html?category=${encodeURIComponent(product.categoryId)}">${escapeHtml(category ? category.name : "Category")}</a>
      </p>
      <h1>${escapeHtml(product.name)}</h1>
      <div class="product-detail__price-row">
        <span class="product-detail__price">${formatNaira(product.price)}</span>
        ${availabilityBadge(product.availability)}
        <span class="rating">${icon("star")} ${product.rating.toFixed(1)}</span>
      </div>
      <p>${escapeHtml(product.description)}</p>

      ${
        vendor
          ? `<a class="vendor-mini-card" href="vendor-store.html?id=${encodeURIComponent(vendor.id)}">
              <img src="${attrUrl(vendor.image)}" alt="${escapeHtml(vendor.storeName)}" />
              <span class="vendor-mini-card__info">
                <strong>${escapeHtml(vendor.storeName)}${vendor.verified ? ` <span class="inline-icon" title="Verified Vendor">${icon("verified")}</span>` : ""}</strong>
                <span>${escapeHtml(vendor.location)}</span>
              </span>
              <span class="badge badge-outline">View Store</span>
            </a>`
          : `<p class="vendor-mini-card vendor-mini-card--missing">Vendor information isn't available for this product.</p>`
      }

      <div class="product-detail__actions">
        ${
          isService
            ? `<a class="btn btn-primary" href="${escapeHtml(contactVendorUrl(product))}">Contact Vendor</a>`
            : isAvailable
            ? `<div class="qty-stepper" id="qty-stepper">
                <button type="button" id="qty-decrease" aria-label="Decrease quantity">&minus;</button>
                <span id="qty-value">1</span>
                <button type="button" id="qty-increase" aria-label="Increase quantity">+</button>
              </div>
              <button type="button" class="btn btn-primary" data-action="add-to-cart">Add to Cart</button>`
            : `<button type="button" class="btn btn-outline" disabled>Unavailable</button>`
        }
        ${
          vendor && !isService
            ? `<a class="btn btn-outline" href="messages.html?vendor=${encodeURIComponent(vendor.id)}&ask=${encodeURIComponent(product.id)}">Contact Vendor</a>`
            : ""
        }
      </div>
      ${isService ? `<p class="product-detail__note">This is a service. Message the vendor to agree the details, price and timing.</p>` : ""}
    </div>
  `;

  const img = detail.querySelector("img");
  withImageFallback(img);

  if (isAvailable && !isService) wireQuantityStepper();
  wireDetailAddToCart(product, detail);
}

// The detail page's own Add to Cart button needs the quantity chosen
// in the stepper, so it's wired directly here rather than through the
// generic wireAddToCartButtons (which always adds quantity 1 — right
// for grid cards, wrong for this page).
function wireDetailAddToCart(product, detail) {
  const btn = detail.querySelector('[data-action="add-to-cart"]');
  if (!btn) return;

  btn.addEventListener("click", () => {
    const qtyEl = document.getElementById("qty-value");
    const quantity = qtyEl ? Number(qtyEl.textContent) : 1;
    const result = addToCart(product.id, quantity);

    const original = btn.textContent;
    btn.textContent = result.success ? "Added ✓" : result.error || "Couldn't add";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1400);
  });
}

function wireQuantityStepper() {
  const stepper = document.getElementById("qty-stepper");
  if (!stepper) return;

  const valueEl = document.getElementById("qty-value");
  const decreaseBtn = document.getElementById("qty-decrease");
  const increaseBtn = document.getElementById("qty-increase");
  const MAX_QTY = 10;
  let qty = 1;

  function render() {
    valueEl.textContent = String(qty);
    decreaseBtn.disabled = qty <= 1;
    increaseBtn.disabled = qty >= MAX_QTY;
  }

  decreaseBtn.addEventListener("click", () => {
    if (qty > 1) qty -= 1;
    render();
  });
  increaseBtn.addEventListener("click", () => {
    if (qty < MAX_QTY) qty += 1;
    render();
  });
  render();
}

function renderRelated(product) {
  const related = getRelatedProducts(product, products, 4);
  const section = document.getElementById("related-section");
  const grid = document.getElementById("related-grid");
  if (!section || !grid) return;

  if (related.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  renderList(grid, related, productCard, "");
  wireAddToCartButtons(grid);
}
