// =====================================================================
// Online payments — what the browser does.
// =====================================================================
// WHAT: (1) works out the online payment fee shown at checkout, and
//       (2) asks the server to start or check a Paystack payment.
// WHY:  the browser never touches Paystack's secret key and never decides
//       an order is paid. It only shows the fee, sends the customer to
//       Paystack, and later asks the server "has this been paid?". The
//       server recalculates the amount itself from your database, and only
//       Paystack's own confirmation can mark an order paid.
// THE FEE FORMULA lives in two places that MUST stay identical: here and in
//       supabase/functions/start-payment/index.ts. Both are tested against
//       the same cases.
// FUTURE: other providers (for example Monnify) would add a second fee rule.
// =====================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../data/supabaseConfig.js";
import { isBackendConfigured } from "./backend.js";
import { getSession } from "./auth.js";

// ---------------------------------------------------------------------
// The fee (Paystack Nigeria, local payments)
// ---------------------------------------------------------------------
//   1.5% of what the customer is charged, plus a flat ₦100 that Paystack
//   waives when the charge is under ₦2,500; the fee never exceeds ₦2,000.
// The student pays the fee, so we charge slightly MORE than the order total,
// so that after Paystack takes its fee Item cart still receives the full total.
// Everything is whole naira, rounded UP, so Item cart is never short.
const RATE_PER_THOUSAND = 15; // 1.5%
const FLAT_FEE = 100;
const FLAT_STARTS_AT = 2500;
const FEE_CAP = 2000;

// What Paystack takes from a charge of `charge` naira (whole naira, rounded up).
function feeTakenFrom(charge) {
  const milli = RATE_PER_THOUSAND * charge + (charge >= FLAT_STARTS_AT ? FLAT_FEE * 1000 : 0);
  return Math.min(Math.floor((milli + 999) / 1000), FEE_CAP);
}

// The smallest whole-naira charge that leaves `orderTotal` after the fee.
// Returns { charge, fee } where fee = charge - orderTotal.
export function computeOnlineCharge(orderTotal) {
  const total = Math.round(Number(orderTotal));
  if (!Number.isFinite(total) || total <= 0) return { charge: 0, fee: 0 };

  const net = (c) => c - feeTakenFrom(c);

  // Case 1: the charge stays under ₦2,500, so there is no flat fee.
  let c = Math.floor((total * 1000 + 984) / 985);
  while (c < FLAT_STARTS_AT && net(c) < total) c++;
  if (c < FLAT_STARTS_AT) return { charge: c, fee: c - total };

  // Case 2: the flat ₦100 applies (and the ₦2,000 cap can apply on big orders).
  c = Math.max(FLAT_STARTS_AT, Math.floor(((total + FLAT_FEE) * 1000 + 984) / 985));
  const uncappedNet = (x) => x - Math.floor((RATE_PER_THOUSAND * x + FLAT_FEE * 1000 + 999) / 1000);
  while (uncappedNet(c) < total) c++;
  while (c > FLAT_STARTS_AT && uncappedNet(c - 1) >= total) c--;
  c = Math.min(c, total + FEE_CAP); // once the cap bites, the fee is simply ₦2,000
  return { charge: c, fee: c - total };
}

// ---------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/start-payment`;
const TIMEOUT_MS = 25000;

async function callServer(action, { transactionId, phone }) {
  if (!isBackendConfigured) return { ok: false, code: "not_configured" };

  // A signed-in customer proves who they are with their login; a guest with
  // the phone number used at checkout (same rule as the confirmation page).
  let token = SUPABASE_ANON_KEY;
  try {
    const session = await getSession();
    if (session && session.access_token) token = session.access_token;
  } catch (_) {
    /* fall back to the public key */
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, transactionId, phone: phone || null }),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* no JSON body */
    }
    if (response.ok) return { ok: true, data: data || {} };
    return { ok: false, code: (data && data.error) || (response.status === 503 ? "not_configured" : "failed"), status: response.status };
  } catch (_) {
    return { ok: false, code: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// Only ever send the customer to Paystack's own checkout, even if a reply were tampered with.
export function isPaystackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paystack.com" || url.hostname.endsWith(".paystack.com"));
  } catch (_) {
    return false;
  }
}

// Asks the server to start a payment. On success: { ok, authorizationUrl, charge, fee }.
// Otherwise { ok: false, code } with code one of:
// not_configured | already_paid | not_found | slow_down | network | failed
export async function startOnlinePayment({ transactionId, phone }) {
  const result = await callServer("start", { transactionId, phone });
  if (!result.ok) return result;
  const data = result.data;
  if (!isPaystackUrl(data.authorizationUrl)) return { ok: false, code: "failed" };
  return { ok: true, authorizationUrl: data.authorizationUrl, charge: data.charge, fee: data.fee };
}

// Asks the server to check with Paystack whether this order has been paid.
// Resolves { ok: true, status: "paid" | "pending" | "review" }.
export async function verifyOnlinePayment({ transactionId, phone }) {
  const result = await callServer("verify", { transactionId, phone });
  if (!result.ok) return result;
  const status = result.data.status;
  return { ok: true, status: status === "paid" || status === "review" ? status : "pending" };
}
