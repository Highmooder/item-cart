// Transaction data model.
// WHAT: the ONE record a customer's payment actually corresponds to.
// A cart spanning multiple vendors still produces exactly one
// transaction — vendor-specific orders (js/data/orders.js) are child
// fulfillment/accounting records underneath it, not separate bills.
// WHY (Phase 4.1): earlier, payment status and delivery fee lived on
// each vendor order, which implied a customer could owe — and pay —
// each vendor separately. Item cart is the transaction owner: customers
// pay Item cart once, and Item cart is responsible for paying vendors out.
// FUTURE: this is what a real payment gateway's webhook would update
// (paymentStatus) once verification is automated, and what an admin
// dashboard would list as "payments received", separate from the
// per-vendor "orders to fulfill" view.
//
// Implemented in js/modules/transactionStore.js, backed by
// localStorage for the prototype. Shape:
//
// {
//   id,                    // e.g. "TXN-1001"
//   schoolId,
//   customer: { name, phone, email, location, note },
//   deliveryMethod: "delivery" | "pickup",   // one choice for the whole checkout
//   orderIds: [...],       // e.g. ["RUN-1001", "RUN-1002"] — the child vendor orders
//
//   subtotal,              // sum of every vendor order's vendorSubtotal — the
//                          // vendors' combined price, before delivery
//   deliveryFee,           // charged ONCE here, never per vendor order
//   total,                 // subtotal + deliveryFee — the ONE amount the customer pays
//
//   commissionTotal,       // sum of every child order's commissionAmount (0 at launch)
//   vendorPayoutTotal,     // sum of every child order's vendorPayout
//
//   paymentStatus: "pending" | "awaiting_verification" | "paid" | "failed" | "refunded",
//
//   createdAt,
//   updatedAt,
// }
//
// paymentStatus lives ONLY here, not on individual orders — a vendor
// order's orderStatus (see js/data/orders.js) describes fulfillment
// progress, which is a different thing from whether Item cart has been
// paid. Collapsing the two onto one field was the bug this model
// fixes: it made it look like each vendor had their own payment to
// collect, when in fact the customer pays Item cart once.

export const transactions = [];
