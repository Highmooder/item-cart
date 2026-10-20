// WHAT: creates and reads Item cart transactions — the parent record a
// customer's ONE payment corresponds to — backed by localStorage for
// this prototype. See js/data/transactions.js for the full shape.
// WHY: mirrors js/modules/orderStore.js's pattern. checkout.js and
// confirmation.js call these functions instead of touching
// localStorage directly, so replacing this with a real backend later
// means editing this one file.
// FUTURE: replace the bodies of these functions with fetch() calls;
// callers already only deal in plain transaction objects.

const TRANSACTIONS_KEY = "item_cart_transactions";
const SEQUENCE_KEY = "item_cart_transaction_seq";
const SEQUENCE_START = 1000;

function readTransactions() {
  try {
    const raw = localStorage.getItem(TRANSACTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Item cart: could not read stored transactions, starting fresh.", error);
    return [];
  }
}

function writeTransactions(transactions) {
  try {
    localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(transactions));
    return true;
  } catch (error) {
    console.warn("Item cart: could not save transactions.", error);
    return false;
  }
}

function nextTransactionId() {
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
    return `TXN-${Date.now()}`;
  }
  return `TXN-${next}`;
}

// Creates the parent transaction — the one record the customer's
// payment corresponds to. Child vendor orders (js/modules/orderStore.js)
// are created separately, right after this, and then attached via
// attachOrderIds() once their ids exist. commissionTotal/vendorPayoutTotal
// are passed in already-computed (summed from each vendor group's
// finance.js result) so the transaction's totals are correct from the
// moment it exists, before any child order is written.
export function createTransaction({ schoolId, customer, deliveryMethod, subtotal, deliveryFee, commissionTotal, vendorPayoutTotal }) {
  const now = new Date().toISOString();

  const transaction = {
    id: nextTransactionId(),
    schoolId,
    customer,
    deliveryMethod,
    orderIds: [],
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
    commissionTotal,
    vendorPayoutTotal,
    // The customer's ONE payment covers this whole transaction, no
    // matter how many vendor orders it splits into for fulfillment.
    // Never "paid" here — only manual admin verification (a later
    // phase) can set that.
    paymentStatus: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const transactions = readTransactions();
  transactions.push(transaction);
  const saved = writeTransactions(transactions);

  if (!saved) {
    return { success: false, error: "Your transaction could not be started. Please try again." };
  }
  return { success: true, transaction };
}

// Records which vendor orders belong to a transaction. Orders need
// the transaction's id to exist first (so it's created before them),
// which means the transaction's own orderIds list has to be filled in
// afterward, once every child order has been created successfully.
export function attachOrderIds(transactionId, orderIds) {
  const transactions = readTransactions();
  const transaction = transactions.find((t) => t.id === transactionId);
  if (!transaction) {
    return { success: false, error: "Transaction not found." };
  }

  transaction.orderIds = orderIds;
  transaction.updatedAt = new Date().toISOString();
  const saved = writeTransactions(transactions);

  if (!saved) {
    return { success: false, error: "Could not finalize the transaction. Please try again." };
  }
  return { success: true, transaction };
}

// Rollback: used if a child vendor order fails to create after the
// transaction was already started, so a customer is never left with a
// transaction record that doesn't correspond to real orders.
export function removeTransaction(id) {
  writeTransactions(readTransactions().filter((transaction) => transaction.id !== id));
}

export function getTransactionById(id) {
  return readTransactions().find((transaction) => transaction.id === id) || null;
}
