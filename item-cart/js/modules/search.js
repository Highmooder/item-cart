import { getVendorById } from "../data/vendors.js";
import { getCategoryById } from "../data/categories.js";

// WHAT: pure functions over a products array — no DOM, no state.
// WHY: both marketplace.js (search/filter/sort) and product.js
// (related products) need the same logic; keeping it here means
// neither page reimplements it.
// FUTURE: once products come from a real API, these can stay as
// client-side refinement over a fetched page, or the calling code
// can send the same parameters to the backend instead — the page
// controllers don't need to change either way.

export function searchProducts(products, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return products;

  return products.filter((product) => {
    const vendor = getVendorById(product.vendorId);
    const category = getCategoryById(product.categoryId);
    const haystack = [
      product.name,
      product.description,
      category ? category.name : "",
      vendor ? vendor.storeName : "",
      vendor ? vendor.location : "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function filterByCategory(products, categoryId) {
  if (!categoryId || categoryId === "all") return products;
  return products.filter((product) => product.categoryId === categoryId);
}

export const SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "price-asc", label: "Price: Low to High" },
  { value: "price-desc", label: "Price: High to Low" },
  { value: "rating-desc", label: "Highest Rated" },
  { value: "newest", label: "Newest" },
];

export function sortProducts(products, sortKey) {
  const list = [...products];
  switch (sortKey) {
    case "price-asc":
      return list.sort((a, b) => a.price - b.price);
    case "price-desc":
      return list.sort((a, b) => b.price - a.price);
    case "rating-desc":
      return list.sort((a, b) => b.rating - a.rating);
    case "newest":
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    case "recommended":
    default:
      // No ranking model yet — catalog order stands in for
      // "recommended" until there's real signal to rank on.
      return list;
  }
}

// Same category first; if there aren't enough, fill with the
// highest-rated remaining products so the section is never sparse
// just because a category is thin (e.g. "Beauty" has one item).
export function getRelatedProducts(product, allProducts, limit = 4) {
  const sameCategory = allProducts.filter(
    (p) => p.id !== product.id && p.categoryId === product.categoryId
  );
  if (sameCategory.length >= limit) return sameCategory.slice(0, limit);

  const fillers = allProducts
    .filter((p) => p.id !== product.id && p.categoryId !== product.categoryId)
    .sort((a, b) => b.rating - a.rating);

  return [...sameCategory, ...fillers].slice(0, limit);
}


// ---------------------------------------------------------------------
// Vendors (used by the Vendors directory)
// ---------------------------------------------------------------------

export function searchVendors(vendors, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return vendors;

  return vendors.filter((vendor) => {
    const category = getCategoryById(vendor.category);
    const haystack = [vendor.storeName, vendor.description, vendor.location, category ? category.name : ""].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

export function filterVendorsByCategory(vendors, categoryId) {
  if (!categoryId || categoryId === "all") return vendors;
  return vendors.filter((vendor) => vendor.category === categoryId);
}

export function filterVerifiedVendors(vendors, verifiedOnly) {
  return verifiedOnly ? vendors.filter((vendor) => vendor.verified) : vendors;
}

export const VENDOR_SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "rating-desc", label: "Highest Rated" },
  { value: "newest", label: "Newest" },
  { value: "name-asc", label: "Name: A to Z" },
];

export function sortVendors(vendors, sortKey) {
  const list = [...vendors];
  const byName = (a, b) => a.storeName.localeCompare(b.storeName);
  switch (sortKey) {
    case "rating-desc":
      return list.sort((a, b) => b.rating - a.rating || byName(a, b));
    case "newest":
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    case "name-asc":
      return list.sort(byName);
    case "recommended":
    default:
      // Verified vendors first, then best rated, then by name.
      return list.sort((a, b) => Number(b.verified) - Number(a.verified) || b.rating - a.rating || byName(a, b));
  }
}
