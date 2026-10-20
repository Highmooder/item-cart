import { getProductById } from "../data/products.js";
import { getVendorById } from "../data/vendors.js";
import { isServiceProduct } from "./services.js";

// WHAT: the customer's cart — a list of { productId, quantity } —
// persisted to localStorage, plus every read/derive operation a page
// needs (totals, vendor grouping, issue detection).
// WHY: every page (home, marketplace, product, cart, checkout)
// touches the cart the same validated way through these functions
// instead of reading/writing localStorage directly.
// FUTURE: swap the bodies of readCart/writeCart for a backend-synced
// cart (e.g. tied to a logged-in account) — callers don't change.

const CART_KEY = "item_cart";
export const MAX_QTY_PER_ITEM = 10;

function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Item cart: could not read the cart, starting empty.", error);
    return [];
  }
}

function writeCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (error) {
    console.warn("Item cart: could not save the cart.", error);
  }
  // Lets the header badge — and any other open view — update
  // immediately without a full page reload.
  window.dispatchEvent(new CustomEvent("item-cart:cart-updated"));
}

function clampQty(qty) {
  const n = Math.floor(Number(qty));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, n), MAX_QTY_PER_ITEM);
}

export function getCart() {
  return readCart();
}

export function getCartCount() {
  return readCart().reduce((sum, line) => sum + line.quantity, 0);
}

// Adds a product to the cart. Refuses unknown or unavailable products
// instead of silently accepting them, and clamps quantity to a sane
// range rather than trusting the caller.
export function addToCart(productId, quantity = 1) {
  const product = getProductById(productId);
  if (!product) {
    return { success: false, error: "That product could not be found." };
  }
  if (isServiceProduct(product)) {
    return { success: false, error: "Services are arranged with the vendor. Use Contact Vendor." };
  }
  if (product.availability === "unavailable") {
    return { success: false, error: `${product.name} is currently unavailable.` };
  }

  const qty = clampQty(quantity);
  const cart = readCart();
  const existing = cart.find((line) => line.productId === productId);

  if (existing) {
    existing.quantity = clampQty(existing.quantity + qty);
  } else {
    cart.push({ productId, quantity: qty });
  }

  writeCart(cart);
  return { success: true };
}

export function updateQuantity(productId, quantity) {
  const cart = readCart();
  const line = cart.find((l) => l.productId === productId);
  if (!line) return { success: false, error: "That item is not in your cart." };

  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) {
    return removeFromCart(productId);
  }

  line.quantity = clampQty(qty);
  writeCart(cart);
  return { success: true };
}

export function removeFromCart(productId) {
  writeCart(readCart().filter((line) => line.productId !== productId));
  return { success: true };
}

export function clearCart() {
  writeCart([]);
}

// Enriches raw cart lines with current product/vendor data, flagging
// any line whose product has disappeared ("missing") or gone
// unavailable ("unavailable") since it was added — instead of
// silently dropping it or miscalculating totals around it.
export function getCartDetails() {
  return readCart().map((line) => {
    const product = getProductById(line.productId);

    if (!product) {
      return { ...line, status: "missing", product: null, vendor: null, lineTotal: 0 };
    }
    // A service can't be bought through the cart (e.g. added before it was
    // listed as a service). It is flagged so it must be removed before checkout.
    if (isServiceProduct(product)) {
      return { ...line, status: "service", product, vendor: getVendorById(product.vendorId), lineTotal: 0 };
    }
    if (product.availability === "unavailable") {
      return {
        ...line,
        status: "unavailable",
        product,
        vendor: getVendorById(product.vendorId),
        lineTotal: 0,
      };
    }

    return {
      ...line,
      status: "ok",
      product,
      vendor: getVendorById(product.vendorId),
      lineTotal: product.price * line.quantity,
    };
  });
}

export function getCartSummary() {
  const lines = getCartDetails();
  const okLines = lines.filter((l) => l.status === "ok");

  return {
    lines,
    itemCount: okLines.reduce((sum, l) => sum + l.quantity, 0),
    subtotal: okLines.reduce((sum, l) => sum + l.lineTotal, 0),
    hasIssues: lines.some((l) => l.status !== "ok"),
  };
}

// Groups valid cart lines by vendor. Item cart's order model is one
// vendor per order (see js/modules/orderStore.js), so a cart spanning
// multiple vendors becomes multiple orders at checkout — this is what
// that split is based on.
export function groupCartByVendor() {
  const { lines } = getCartSummary();
  const groups = new Map();

  lines
    .filter((l) => l.status === "ok")
    .forEach((line) => {
      const vendorId = line.product.vendorId;
      if (!groups.has(vendorId)) groups.set(vendorId, []);
      groups.get(vendorId).push(line);
    });

  return Array.from(groups.entries()).map(([vendorId, vendorLines]) => ({
    vendorId,
    vendor: getVendorById(vendorId),
    lines: vendorLines,
    subtotal: vendorLines.reduce((sum, l) => sum + l.lineTotal, 0),
  }));
}

// Wires "Add to Cart" buttons within a container via delegation, so
// it keeps working after renderList() replaces the container's
// children on every search/filter/sort re-render. Always adds
// quantity 1 — the product detail page's own stepper is wired
// separately since it needs the chosen quantity, not a fixed one.
export function wireAddToCartButtons(container) {
  if (!container || container.dataset.cartWired === "true") return;
  container.dataset.cartWired = "true";

  container.addEventListener("click", (event) => {
    const btn = event.target.closest('[data-action="add-to-cart"]');
    if (!btn || btn.disabled) return;

    const result = addToCart(btn.dataset.productId, 1);
    const original = btn.textContent;
    btn.textContent = result.success ? "Added ✓" : result.error || "Couldn't add";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1400);
  });
}
