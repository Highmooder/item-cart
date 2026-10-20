import { ITEMCART_CONFIG } from "../data/config.js";

// WHAT: the one place that turns a vendor's subtotal into a
// commission amount and a vendor payout.
// WHY: commission math must never be duplicated or hard-coded at
// each call site. Every order creation path calls this instead —
// so activating a future commission is a one-line change to
// ITEMCART_CONFIG.commissionRate, not a hunt through checkout/order code.
// During launch, commissionRate is 0: commissionAmount is always 0
// and vendorPayout always equals vendorSubtotal exactly.
export function computeCommission(vendorSubtotal) {
  const rate = ITEMCART_CONFIG.commissionRate || 0;
  const commissionAmount = Math.round(vendorSubtotal * rate);
  const vendorPayout = vendorSubtotal - commissionAmount;
  return { rate, commissionAmount, vendorPayout };
}
