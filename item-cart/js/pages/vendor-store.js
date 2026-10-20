import { renderHeader, renderFooter } from "../modules/layout.js";
import { finishLoading } from "../modules/loading.js";
import { loadCatalog } from "../modules/catalog.js";
import { getVendorById } from "../data/vendors.js";
import { getCategoryById } from "../data/categories.js";
import { getCurrentSchool } from "../data/schools.js";
import { products } from "../data/products.js";
import { renderList, productCard, withImageFallback } from "../modules/render.js";
import { wireAddToCartButtons } from "../modules/cart.js";
import { escapeHtml, attrUrl } from "../modules/escape.js";
import { icon } from "../modules/icons.js";

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("vendors.html");
  renderFooter();
  await loadCatalog();
  finishLoading();

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const vendor = id ? getVendorById(id) : null;

  if (!vendor) {
    showMissingState();
    return;
  }

  document.getElementById("vendor-found").style.display = "block";
  document.title = `${vendor.storeName} — Item cart`;

  renderHero(vendor);

  if (vendor.active === false) {
    document.getElementById("vendor-inactive-notice").style.display = "block";
    // An inactive vendor's store isn't taking orders right now —
    // don't render a product grid that implies otherwise.
    return;
  }

  renderProducts(vendor);
});

function showMissingState() {
  document.getElementById("vendor-missing").style.display = "block";
  document.title = "Vendor not found — Item cart";
}

function renderHero(vendor) {
  const category = getCategoryById(vendor.category);
  const school = getCurrentSchool();

  const hero = document.getElementById("vendor-hero");
  hero.innerHTML = `
    <img class="vendor-hero__logo" src="${attrUrl(vendor.image)}" alt="${escapeHtml(vendor.storeName)}" />
    <div class="vendor-hero__info">
      <div class="vendor-hero__name-row">
        <h1>${escapeHtml(vendor.storeName)}</h1>
        ${vendor.verified ? `<span class="badge badge-verified">${icon("verified")} Verified Vendor</span>` : ""}
      </div>
      <div class="vendor-hero__meta">
        ${category ? `<span>${escapeHtml(category.name)}</span>` : ""}
        <span class="vendor-hero__location">${icon("location")} ${escapeHtml(vendor.location)}</span>
        ${school ? `<span>${escapeHtml(school.abbreviation)}</span>` : ""}
        <span class="rating">${icon("star")} ${vendor.rating ? vendor.rating.toFixed(1) : "New"}</span>
      </div>
      <p class="vendor-hero__description">${escapeHtml(vendor.description)}</p>
    </div>
    <div class="vendor-hero__actions">
      <a class="btn btn-primary" href="messages.html?vendor=${encodeURIComponent(vendor.id)}">Contact Vendor</a>
    </div>
  `;

  const img = hero.querySelector("img");
  withImageFallback(img);
}

function renderProducts(vendor) {
  const vendorProducts = products.filter((product) => product.vendorId === vendor.id);
  const grid = document.getElementById("vendor-product-grid");

  renderList(grid, vendorProducts, productCard, "This vendor hasn't listed any products yet.");
  wireAddToCartButtons(grid);
}
