import { computeCommission } from "./finance.js";

// WHAT: creates and reads Item cart orders, backed by localStorage for
// this prototype.
// WHY: every page that touches orders (checkout, confirmation) calls
// these functions instead of reading/writing localStorage directly —
// so replacing this with real API calls later means editing this one
// file, not every page that uses it.
// FUTURE: replace the bodies of these functions with fetch() calls to
// a real backend; callers (checkout.js, confirmation.js) don't change,
// since they already only deal in plain order objects.

const ORDERS_KEY = "item_cart_orders";
const SEQUENCE_KEY = "item_cart_order_seq";
const SEQUENCE_START = 1000;

function readOrders() {
  try {
    const raw = localStorage.getItem(ORDERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Item cart: could not read stored orders, starting fresh.", error);
    return [];
  }
}

function writeOrders(orders) {
  try {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
    return true;
  } catch (error) {
    console.warn("Item cart: could not save orders.", error);
    return false;
  }
}

function nextOrderId() {
  let seq = SEQUENCE_START;
  try {
    const stored = localStorage.getItem(SEQUENCE_KEY);
    const parsed = stored ? parseInt(stored, 10) : SEQUENCE_START;
    seq = Number.isNaN(parsed) ? SEQUENCE_START : parsed;
  } catch (error) {
    seq = SEQUENCE_START;
  }

  const next = seq + 1;
  try {
    localStorage.setItem(SEQUENCE_KEY, String(next));
  } catch (error) {
    // If the sequence itself can't be persisted, fall back to a
    // timestamp-based id so order creation still succeeds rather
    // than failing on something as small as an id counter.
    return `RUN-${Date.now()}`;
  }
  return `RUN-${next}`;
}

// Creates one vendor order — a fulfillment/accounting child record
// under a parent transaction (js/modules/transactionStore.js). See
// js/data/orders.js for the full field-by-field shape and reasoning.
// Called once per vendor group when a cart spans multiple vendors.
// Commission is never passed in by the caller — it's always computed
// here, centrally, from ITEMCART_CONFIG.commissionRate via finance.js.
// Delivery fee and payment status live on the transaction, not here —
// an order only knows its own vendor's subtotal and payout.
export function createOrder({
  transactionId,
  schoolId,
  vendorId,
  vendorWhatsapp,
  customer,
  deliveryMethod,
  items,
  subtotal,
}) {
  if (!items || items.length === 0) {
    return { success: false, error: "Cannot create an order with no items." };
  }
  if (!transactionId) {
    return { success: false, error: "Cannot create an order without a parent transaction." };
  }

  const now = new Date().toISOString();
  const { rate, commissionAmount, vendorPayout } = computeCommission(subtotal);

  const order = {
    id: nextOrderId(),
    transactionId,
    schoolId,
    vendorId,
    customer,
    deliveryMethod,
    items,
    vendorSubtotal: subtotal,
    commissionRate: rate,
    commissionAmount,
    vendorPayout,
    // Fulfillment progress only — whether Item cart has been PAID lives
    // on the parent transaction (transaction.paymentStatus), never
    // here. See the hybrid-model note in js/data/orders.js.
    orderStatus: "pending",
    disputeStatus: "none",
    communication: { channel: "whatsapp", vendorWhatsapp: vendorWhatsapp || null },
    createdAt: now,
    updatedAt: now,
  };

  const orders = readOrders();
  orders.push(order);
  const saved = writeOrders(orders);

  if (!saved) {
    return { success: false, error: "Your order could not be saved. Please try again." };
  }
  return { success: true, order };
}

// Best-effort rollback: used when one order in a multi-vendor
// checkout succeeds but a later one fails, so a customer is never
// left with a partial order they didn't confirm.
export function removeOrders(ids) {
  writeOrders(readOrders().filter((order) => !ids.includes(order.id)));
}

export function getOrderById(id) {
  return readOrders().find((order) => order.id === id) || null;
}

export function getOrdersByIds(ids) {
  const all = readOrders();
  return ids.map((id) => all.find((order) => order.id === id)).filter(Boolean);
}
