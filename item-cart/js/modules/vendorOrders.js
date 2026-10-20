import { getSupabase } from "./backend.js";

// WHAT: what a vendor's team needs to run their orders: list the store's
// paid orders, and mark one Ready.
// WHY: pages call these small functions and get {ok, data, error} back, so
// they never touch Supabase directly (same pattern as vendorProducts.js).
// SECURITY: the database decides everything (10_vendor_orders.sql). It only
// returns PAID orders for a store the person manages, and "Ready" is the
// only status a vendor can set. This file only asks.
// FUTURE: alerts for new paid orders, and a Completed step.

async function rpc(name, args) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { ok: false, error: friendlyError(error) };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export function listOrders(vendorId) {
  return rpc("vendor_list_orders", { p_vendor_id: vendorId });
}

export function markOrderReady(orderId) {
  return rpc("vendor_mark_order_ready", { p_order_id: orderId });
}

export function friendlyError(error) {
  const msg = (error && error.message) || "";
  // P0001 = a message we wrote on purpose in the database function.
  if (error && error.code === "P0001" && msg) return msg;
  if (error && (error.code === "PGRST202" || /could not find the function/i.test(msg))) return "Orders aren't set up yet. Please try again later.";
  if (/JWT|not authenticated|expired/i.test(msg)) return "Your session expired. Please sign in again.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach the server. Check your internet connection.";
  return "Something went wrong. Please try again.";
}
