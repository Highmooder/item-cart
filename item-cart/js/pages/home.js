import { renderHeader, renderFooter } from "../modules/layout.js";
import { loadCatalog } from "../modules/catalog.js";
import { categories } from "../data/categories.js";
import { products } from "../data/products.js";
import { vendors } from "../data/vendors.js";
import { renderList, categoryCard, productCard, vendorCard, formatNaira, withImageFallback, availabilityBadge } from "../modules/render.js";
import { escapeHtml, attrUrl } from "../modules/escape.js";
import { wireAddToCartButtons } from "../modules/cart.js";
// Ask Item cart AI: only a small button loads now; the chat downloads when it is tapped.
import "../modules/askLauncher.js";

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("index.html");
  renderFooter();
  await loadCatalog();

  renderCategories();
  renderSearchPreview();
  renderFeaturedProducts();
  renderPopularVendors();
  wireHeroSearch();
});

function renderCategories() {
  const grid = document.getElementById("category-grid");
  if (!grid) return;
  renderList(grid, categories, categoryCard, "No categories available right now.");
}

function renderFeaturedProducts() {
  const grid = document.getElementById("featured-products");
  if (!grid) return;
  // Featured = first 8 sample products. A real "featured" flag can
  // replace this slice once the backend exists.
  renderList(grid, products.slice(0, 8), productCard, "No products available right now.");
  wireAddToCartButtons(grid);
}

function renderPopularVendors() {
  const grid = document.getElementById("popular-vendors");
  if (!grid) return;
  renderList(grid, vendors.slice(0, 3), vendorCard, "No vendors available right now.");
}

function renderSearchPreview() {
  const list = document.getElementById("search-preview-list");
  if (!list) return;

  const sample = products.slice(0, 3);
  list.innerHTML = sample
    .map(
      (product) => `
        <div class="search-preview__row">
          <img class="search-preview__thumb" src="${attrUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" />
          <div class="search-preview__info">
            <strong>${escapeHtml(product.name)}</strong>
            ${availabilityBadge(product.availability)}
          </div>
          <span class="search-preview__price">${formatNaira(product.price)}</span>
        </div>
      `
    )
    .join("");

  list.querySelectorAll("img").forEach(withImageFallback);
}

function wireHeroSearch() {
  const form = document.getElementById("hero-search-form");
  if (!form) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = new FormData(form).get("q");
    const params = query ? `?q=${encodeURIComponent(String(query))}` : "";
    window.location.href = `marketplace.html${params}`;
  });
}
