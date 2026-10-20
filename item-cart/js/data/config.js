// Item cart platform configuration.
// WHAT: a single place for values that will eventually come from a
// real settings/admin system — the business WhatsApp number and
// payment instructions customers see at checkout.
// WHY: keeping these out of page markup means updating them later is
// a one-line change here, and makes it unmistakable that these are
// placeholders, not real contact or banking details.
// FUTURE: this becomes a call to a settings API once an admin
// dashboard exists to manage it.

export const ITEMCART_CONFIG = {
  // Item cart's cut of a vendor's subtotal, as a decimal (0.05 = 5%).
  // 0 during the launch period — customers pay exactly the vendor's
  // price plus delivery, and vendors are paid their full subtotal.
  // This is the ONLY place commission math should read a rate from
  // (see js/modules/finance.js) — activating a future commission
  // means changing this one number, not touching checkout/order code.
  commissionRate: 0,

  // Placeholder only — replace with Item cart's official business
  // WhatsApp number before launch. This must never be a personal
  // number, and is never used as the purchasing mechanism itself —
  // only for notifying Item cart about an order that already exists.
  adminWhatsappNumber: "+2348062763628",

  // Flat fee applied ONCE per checkout (the parent transaction) when
  // the customer chooses delivery — never per vendor order. Pickup is
  // free. A future phase can replace this with distance- or
  // vendor-based pricing without changing callers.
  deliveryFee: 500,

  // Online payment with Paystack (see database/PAYSTACK_SETUP.md).
  // Leave `enabled` as false until the database file 11_online_payments.sql
  // has been run, both Edge Functions are deployed and the Paystack secret
  // key is set. While it is false, checkout looks and works exactly as before
  // (customers pay by bank transfer and you confirm it). When it is true,
  // checkout offers "Pay online"; the student pays the small fee, which is
  // shown before they commit.
  // TURNED OFF for now: customers pay by bank transfer only. Nothing about
  // Paystack shows on checkout or the confirmation page while this is false.
  // To bring it back later, set it to true (all the code is still in place).
  onlinePayments: {
    enabled: false,
  },

  // The in-site chat customers use to send their bank-transfer receipt to
  // Item cart. It is a hidden "store" in the vendors table (see
  // database/16_support_chat_and_receipts.sql); the admin answers it from the
  // Messages page after linking their login to it in admin.html > Vendors.
  supportVendorId: "runnit-admin",
  supportName: "Item cart Admin",

  // Details shown on the Privacy Policy and Terms of Service pages.
  // `draft: true` shows a "draft, have it reviewed" notice at the top of both
  // pages. Replace the placeholders, get the text reviewed (ideally by a
  // Nigerian lawyer), then set `draft` to false.
  legal: {
    draft: true,
    businessName: "Item cart",
    contactEmail: "mahmuudfolayemi8@gmail.com",
    lastUpdated: "15 October 2026",
  },

  // The bank account customers pay into when they choose bank transfer.
  // Shown after an order is created; Item cart staff verify the payment in
  // the admin Orders tab. Double-check these details: customers will
  // send real money to this account.
  paymentInstructions: {
    bankName: "OPAY",
    accountName: "Item cart Nigeria ",
    accountNumber: "8062763628",
    note: "Send the exact total shown above by bank transfer and put your Transaction ID in the transfer description. Item cart confirms your payment before your vendors start preparing your order.",
  },
};
