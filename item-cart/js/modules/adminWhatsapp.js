import { ITEMCART_CONFIG } from "../data/config.js";
import { formatNaira } from "./render.js";
import { getVendorById } from "../data/vendors.js";

// WHAT: builds a wa.me link, pre-filled with a transaction and its
// child vendor orders, pointed at Item cart's admin/business number
// (ITEMCART_CONFIG — a placeholder, never a personal number).
// WHY: the customer pays Item cart ONE amount for the whole transaction,
// not one per vendor — this message reflects that structure: the
// transaction's total and payment status once, then each vendor
// order's fulfillment detail underneath. WhatsApp is a communication
// channel here, never the payment processor.
export function buildAdminWhatsappLink(transaction, orders) {
  const digitsOnly = (ITEMCART_CONFIG.adminWhatsappNumber || "").replace(/[^\d]/g, "");
  if (!digitsOnly) return "#";

  const lines = [
    `Item cart Transaction: ${transaction.id}`,
    `Customer: ${transaction.customer.name}`,
    `Customer total: ${formatNaira(transaction.total)}`,
    `Payment status: ${transaction.paymentStatus}`,
    transaction.deliveryMethod === "delivery"
      ? `Delivery to: ${transaction.customer.location || "Not provided"}`
      : "Pickup — arranged with each vendor",
    "",
    "Vendor orders:",
    ...orders.flatMap((order) => {
      const vendor = getVendorById(order.vendorId);
      return [
        `${order.id} — ${order.vendorName || (vendor ? vendor.storeName : "Vendor")}`,
        `  Vendor subtotal: ${formatNaira(order.vendorSubtotal)}`,
        `  Commission: ${formatNaira(order.commissionAmount)}`,
        `  Vendor payout: ${formatNaira(order.vendorPayout)}`,
      ];
    }),
  ];

  const text = encodeURIComponent(lines.join("\n"));
  return `https://wa.me/${digitsOnly}?text=${text}`;
}
