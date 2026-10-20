import { renderHeader, renderFooter } from "../modules/layout.js";
import { loadCatalog } from "../modules/catalog.js";
import { categories } from "../data/categories.js";
import { products } from "../data/products.js";
import { renderList, productCard } from "../modules/render.js";
import { wireAddToCartButtons } from "../modules/cart.js";
import { searchProducts, filterByCategory, sortProducts, SORT_OPTIONS } from "../modules/search.js";
import { escapeHtml } from "../modules/escape.js";
// Ask Item cart AI: only a small button loads now; the chat downloads when it is tapped.
import "../modules/askLauncher.js";

// Filter/sort state lives in the URL (?q=&category=&sort=) so a
// filtered view is shareable/bookmarkable, and so a product page's
// "back to category" link can land the user on the right view.
const state = {
  query: "",
  category: "all",
  sort: "recommended",
};

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("marketplace.html");
  renderFooter();
  await loadCatalog();

  readStateFromUrl();
  renderCategoryChips();
  renderSortOptions();
  wireSearchInput();
  wireResetButton();
  wireGridActions();
  applyFiltersAndRender();
});

function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.query = params.get("q") || "";
  state.category = params.get("category") || "all";
  state.sort = params.get("sort") || "recommended";

  const input = document.getElementById("marketplace-search-input");
  if (input) input.value = state.query;
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.category !== "all") params.set("category", state.category);
  if (state.sort !== "recommended") params.set("sort", state.sort);
  const qs = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${qs ? "?" + qs : ""}`);
}

function renderCategoryChips() {
  const container = document.getElementById("category-filters");
  if (!container) return;

  const chips = [{ id: "all", name: "All" }, ...categories];
  container.innerHTML = chips
    .map((c) => `<button type="button" class="filter-chip" data-category="${escapeHtml(c.id)}" aria-pressed="false">${escapeHtml(c.name)}</button>`)
    .join("");

  container.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-category]");
    if (!btn) return;
    state.category = btn.dataset.category;
    updateUrl();
    applyFiltersAndRender();
  });
}

function renderSortOptions() {
  const select = document.getElementById("sort-select");
  if (!select) return;
  select.innerHTML = SORT_OPTIONS.map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`).join("");
  select.value = state.sort;

  select.addEventListener("change", () => {
    state.sort = select.value;
    updateUrl();
    applyFiltersAndRender();
  });
}

function wireSearchInput() {
  const form = document.getElementById("marketplace-search-form");
  const input = document.getElementById("marketplace-search-input");
  if (!form || !input) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.query = input.value;
    updateUrl();
    applyFiltersAndRender();
  });

  input.addEventListener("input", () => {
    state.query = input.value;
    updateUrl();
    applyFiltersAndRender();
  });
}

function wireResetButton() {
  const btn = document.getElementById("reset-filters");
  if (!btn) return;
  btn.addEventListener("click", () => {
    state.query = "";
    state.category = "all";
    state.sort = "recommended";
    const input = document.getElementById("marketplace-search-input");
    if (input) input.value = "";
    updateUrl();
    applyFiltersAndRender();
  });
}

function wireGridActions() {
  const grid = document.getElementById("marketplace-grid");
  wireAddToCartButtons(grid);
}

function applyFiltersAndRender() {
  updateActiveChip();

  let results = searchProducts(products, state.query);
  results = filterByCategory(results, state.category);
  results = sortProducts(results, state.sort);

  renderResultsCount(results.length);
  renderGrid(results);
}

function updateActiveChip() {
  document.querySelectorAll("[data-category]").forEach((chip) => {
    const isActive = chip.dataset.category === state.category;
    chip.classList.toggle("is-active", isActive);
    chip.setAttribute("aria-pressed", String(isActive));
  });
}

function renderResultsCount(count) {
  const el = document.getElementById("results-count");
  if (!el) return;
  el.textContent = `${count} product${count === 1 ? "" : "s"} found`;
}

function renderGrid(results) {
  const grid = document.getElementById("marketplace-grid");
  const emptyState = document.getElementById("marketplace-empty");
  if (!grid || !emptyState) return;

  if (results.length === 0) {
    grid.innerHTML = "";
    grid.style.display = "none";
    emptyState.style.display = "block";
    return;
  }

  emptyState.style.display = "none";
  grid.style.display = "grid";
  renderList(grid, results, productCard, "");
}
