import { icon } from "./icons.js";
import { getVendorById } from "../data/vendors.js";
import { getCategoryById } from "../data/categories.js";
import { products } from "../data/products.js";
import { escapeHtml, attrUrl } from "./escape.js";
import { isServiceProduct, contactVendorUrl } from "./services.js";

// WHAT: small pure functions that turn a data record into an HTML
// string. WHY: every page that needs a product/vendor/category card
// imports from here instead of re-writing markup, so the visual
// design only has to change in one place.

// Re-exported so existing imports keep working; the code lives in escape.js.
export { escapeHtml };

export function formatNaira(amount) {
  return "₦" + Number(amount).toLocaleString("en-NG");
}

export function availabilityBadge(availability) {
  if (availability === "in-stock") {
    return '<span class="badge">Available</span>';
  }
  if (availability === "limited") {
    return '<span class="badge badge-accent">Limited stock</span>';
  }
  return '<span class="badge badge-outline">Unavailable</span>';
}

// Attaches an error handler so a broken image URL degrades to a
// quiet placeholder tile instead of a broken-image icon.
// A missing or broken picture is swapped for a quiet tile showing the first
// letter of the name, instead of a broken-image icon and a block of alt text.
// The <img> element stays where it is, so every existing size, crop and
// round-corner rule keeps applying to the replacement.
function placeholderTile(letter) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#EFEDE4"/>` +
    `<text x="200" y="150" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="80" font-weight="700" fill="#66716B">${escapeHtml(letter)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function withImageFallback(imgEl) {
  const showPlaceholder = () => {
    const name = (imgEl.alt || "").replace(/\s+storefront$/i, "").trim();
    imgEl.src = placeholderTile((name.charAt(0) || "?").toUpperCase());
  };
  imgEl.addEventListener("error", showPlaceholder, { once: true });
  const src = imgEl.getAttribute("src");
  if (!src) showPlaceholder();
}

export function productCard(product) {
  const vendor = getVendorById(product.vendorId);
  const vendorName = vendor ? vendor.storeName : "Item cart Vendor";
  const isAvailable = product.availability !== "unavailable";
  const isService = isServiceProduct(product);

  const card = document.createElement("article");
  card.className = "product-card";
  card.innerHTML = `
    <a class="product-card__media" href="product.html?id=${encodeURIComponent(product.id)}">
      <img src="${attrUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" />
    </a>
    <div class="product-card__body">
      <a class="product-card__name" href="product.html?id=${encodeURIComponent(product.id)}">${escapeHtml(product.name)}</a>
      <div class="product-card__meta">
        <p class="product-card__vendor">${escapeHtml(vendorName)}</p>
        <span class="rating">${icon("star")} ${product.rating ? product.rating.toFixed(1) : "New"}</span>
      </div>
      <div class="product-card__top-row">
        <span class="product-card__price">${formatNaira(product.price)}</span>
        ${availabilityBadge(product.availability)}
      </div>
      <div class="product-card__footer">
        ${
          isService
            ? `<a class="btn btn-outline btn-sm" href="${escapeHtml(contactVendorUrl(product))}">Contact Vendor</a>`
            : isAvailable
              ? `<button type="button" class="btn btn-outline btn-sm" data-action="add-to-cart" data-product-id="${escapeHtml(product.id)}">Add to Cart</button>`
              : `<button type="button" class="btn btn-outline btn-sm" disabled>Unavailable</button>`
        }
        <a class="btn btn-primary btn-sm" href="product.html?id=${encodeURIComponent(product.id)}">View Details</a>
      </div>
    </div>
  `;

  const img = card.querySelector("img");
  withImageFallback(img);

  return card;
}

export function vendorCard(vendor) {
  const category = getCategoryById(vendor.category);
  const productCount = products.filter((p) => p.vendorId === vendor.id).length;

  const card = document.createElement("article");
  card.className = "vendor-card";
  card.innerHTML = `
    <div class="vendor-card__media">
      <img src="${attrUrl(vendor.image)}" alt="${escapeHtml(vendor.storeName)} storefront" loading="lazy" />
    </div>
    <div class="vendor-card__body">
      <div class="vendor-card__top-row">
        <h3>${escapeHtml(vendor.storeName)}</h3>
        <span class="rating">${icon("star")} ${vendor.rating ? vendor.rating.toFixed(1) : "New"}</span>
      </div>
      <div class="vendor-card__tags">
        <span class="badge badge-outline">${escapeHtml(category ? category.name : vendor.category)}</span>
        ${vendor.verified ? `<span class="badge badge-verified">${icon("verified")} Verified</span>` : ""}
      </div>
      <ul class="vendor-card__meta">
        <li>${icon("location")}<span>${escapeHtml(vendor.location)}</span></li>
        <li>${icon("box")}<span>${productCount} ${productCount === 1 ? "product" : "products"}</span></li>
      </ul>
      <div class="vendor-card__actions">
        <a class="btn btn-primary btn-sm" href="vendor-store.html?id=${encodeURIComponent(vendor.id)}">View Store</a>
        <a class="btn btn-outline btn-sm" href="messages.html?vendor=${encodeURIComponent(vendor.id)}">Contact Vendor</a>
      </div>
    </div>
  `;

  const img = card.querySelector("img");
  withImageFallback(img);

  return card;
}

export function categoryCard(category) {
  const link = document.createElement("a");
  link.className = "category-card";
  link.href = `marketplace.html?category=${encodeURIComponent(category.id)}`;
  link.innerHTML = `
    <span class="category-card__icon">${icon(category.icon)}</span>
    <span class="category-card__name">${escapeHtml(category.name)}</span>
  `;
  return link;
}

// Renders a list of records into a container using a builder function.
// Shows an empty-state message if the list is empty, so a future
// filtered view (e.g. no vendors in a category) never renders blank.
export function renderList(container, items, builder, emptyMessage) {
  container.innerHTML = "";
  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const message = document.createElement("p");
    message.textContent = emptyMessage;
    empty.appendChild(message);
    container.appendChild(empty);
    return;
  }
  items.forEach((item) => container.appendChild(builder(item)));
}

