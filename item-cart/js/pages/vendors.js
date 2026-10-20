import { renderHeader, renderFooter } from "../modules/layout.js";
import { loadCatalog } from "../modules/catalog.js";
import { categories } from "../data/categories.js";
import { vendors } from "../data/vendors.js";
import { renderList, vendorCard } from "../modules/render.js";
import { escapeHtml } from "../modules/escape.js";
import { searchVendors, filterVendorsByCategory, filterVerifiedVendors, sortVendors, VENDOR_SORT_OPTIONS } from "../modules/search.js";

// WHAT: the Vendors directory — every active vendor, with search,
// category filter, "verified only" and sorting.
// WHY: students can browse stores directly, not only through products.
// Filter/sort state lives in the URL (?q=&category=&sort=&verified=1) so a
// filtered view can be shared or bookmarked, like the Marketplace.

const state = {
  query: "",
  category: "all",
  sort: "recommended",
  verified: false,
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("vendors.html");
  renderFooter();
  await loadCatalog();

  readStateFromUrl();
  renderCategoryChips();
  renderSortOptions();
  wireControls();
  applyFiltersAndRender();
});

function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.query = params.get("q") || "";
  state.category = params.get("category") || "all";
  state.sort = VENDOR_SORT_OPTIONS.some((o) => o.value === params.get("sort")) ? params.get("sort") : "recommended";
  state.verified = params.get("verified") === "1";
  $("vendor-search-input").value = state.query;
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.category !== "all") params.set("category", state.category);
  if (state.sort !== "recommended") params.set("sort", state.sort);
  if (state.verified) params.set("verified", "1");
  const qs = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${qs ? "?" + qs : ""}`);
}

function renderCategoryChips() {
  const container = $("vendor-category-filters");
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
  const select = $("vendor-sort-select");
  select.innerHTML = VENDOR_SORT_OPTIONS.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
  select.value = state.sort;
  select.addEventListener("change", () => {
    state.sort = select.value;
    updateUrl();
    applyFiltersAndRender();
  });
}

function wireControls() {
  const input = $("vendor-search-input");
  $("vendor-search-form").addEventListener("submit", (event) => {
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

  $("verified-toggle").addEventListener("click", () => {
    state.verified = !state.verified;
    updateUrl();
    applyFiltersAndRender();
  });

  $("vendor-reset-filters").addEventListener("click", () => {
    state.query = "";
    state.category = "all";
    state.sort = "recommended";
    state.verified = false;
    input.value = "";
    $("vendor-sort-select").value = "recommended";
    updateUrl();
    applyFiltersAndRender();
  });
}

function applyFiltersAndRender() {
  document.querySelectorAll("#vendor-category-filters [data-category]").forEach((chip) => {
    const active = chip.dataset.category === state.category;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  const verifiedChip = $("verified-toggle");
  verifiedChip.classList.toggle("is-active", state.verified);
  verifiedChip.setAttribute("aria-pressed", String(state.verified));

  // Only vendors that are open on Item cart are listed.
  let results = vendors.filter((vendor) => vendor.active !== false);
  results = searchVendors(results, state.query);
  results = filterVendorsByCategory(results, state.category);
  results = filterVerifiedVendors(results, state.verified);
  results = sortVendors(results, state.sort);

  $("vendor-results-count").textContent = `${results.length} vendor${results.length === 1 ? "" : "s"} found`;

  const grid = $("vendor-directory");
  const empty = $("vendor-empty");
  if (results.length === 0) {
    grid.innerHTML = "";
    grid.style.display = "none";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  grid.style.display = "grid";
  renderList(grid, results, vendorCard, "");
}
