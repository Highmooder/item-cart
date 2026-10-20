import { getVendorById } from "../data/vendors.js";

// WHAT: decides whether a product is a SERVICE (repairs, printing, laundry...)
// rather than a physical item.
// WHY: services are arranged with the vendor — price, time and details are
// agreed in chat — so they don't go in the cart. Every page asks this one
// function, so the rule can't drift between the Marketplace, product page,
// vendor page and cart.
// THE RULE: a product is a service if its own category is "Services", OR
// its vendor is listed under "Services".
// FUTURE: a per-product "contact only" switch, if a vendor needs a mix.

export const SERVICE_CATEGORY_ID = "services";

export function isServiceProduct(product) {
  if (!product) return false;
  if (product.categoryId === SERVICE_CATEGORY_ID) return true;
  const vendor = getVendorById(product.vendorId);
  return !!vendor && vendor.category === SERVICE_CATEGORY_ID;
}

// Where "Contact Vendor" goes: the on-site chat, with the product pre-selected
// so the vendor knows what the customer is asking about.
export function contactVendorUrl(product) {
  return `messages.html?vendor=${encodeURIComponent(product.vendorId)}&ask=${encodeURIComponent(product.id)}`;
}
