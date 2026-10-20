// Order data model.
// WHAT: a single vendor's fulfillment/accounting record — items,
// vendor subtotal, commission split, and fulfillment status. Every
// order belongs to exactly one parent transaction (see
// js/data/transactions.js), which is the record the customer's
// payment actually corresponds to.
// WHY (Phase 4.1): orders used to carry their own delivery fee and
// payment status, which implied a customer owed — and paid — each
// vendor separately. That's no longer true: Item cart is the transaction
// owner. A customer pays ONE total to Item cart; orders exist so each
// vendor's portion of that transaction can be tracked and fulfilled
// independently.
// FUTURE: this shape is what a future vendor dashboard reads — each
// vendor sees only their own orders (filtered by vendorId), each
// carrying exactly the financial detail that vendor needs
// (vendorSubtotal, commissionAmount, vendorPayout) without exposing
// the customer's full transaction or other vendors' orders.
//
// Implemented in js/modules/orderStore.js, backed by localStorage for
// the prototype. Shape:
//
// {
//   id,                    // e.g. "RUN-1001"
//   transactionId,         // e.g. "TXN-1001" — the parent the customer actually paid
//   schoolId,
//   vendorId,               // one vendor per order — a multi-vendor cart becomes
//                           // multiple orders under one transaction at checkout
//   customer: { name, phone, email, location, note },  // denormalized from the
//                           // transaction so a vendor-facing view is self-sufficient
//   deliveryMethod: "delivery" | "pickup",  // for fulfillment context — the fee
//                           // itself lives only on the transaction, never here
//   items: [{ productId, name, price, quantity, vendorId }],
//
//   vendorSubtotal,        // sum of this vendor's item price × quantity, pre-commission
//   commissionRate,        // the rate in effect when this order was created (0 at launch)
//   commissionAmount,      // vendorSubtotal * commissionRate, rounded — always 0 at launch
//   vendorPayout,          // vendorSubtotal - commissionAmount — always equals vendorSubtotal at launch
//
//   orderStatus: "pending" | "confirmed" | "processing" | "ready" | "completed" | "cancelled",
//   disputeStatus: "none" | "open" | "resolved",
//   communication: { channel: "whatsapp", vendorWhatsapp },  // reference to the channel used, not the transaction
//   createdAt,
//   updatedAt,
// }
//
// There is deliberately no paymentStatus, deliveryFee, or total field
// here — those live exclusively on the parent transaction
// (js/data/transactions.js). A vendor order's orderStatus describes
// fulfillment progress, which is a different thing from whether
// Item cart has been paid; collapsing the two onto one order-level field
// was the exact bug Phase 4.1 corrects.
//
// commissionRate/commissionAmount/vendorPayout are order-level, not
// per-item: since one order always belongs to one vendor (see
// vendorId above), computing commission per item would just repeat
// the same rate and risk double-counting it — the order-level figure
// is already the correct granularity for a future vendor dashboard.

export const orders = [];
