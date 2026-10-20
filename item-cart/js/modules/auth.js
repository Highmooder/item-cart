import { getSupabase, isBackendConfigured } from "./backend.js";

// WHAT: everything the storefront needs for customer accounts — sign up,
// sign in, sign out, password reset, profile, and order history.
// WHY: pages never talk to Supabase Auth directly; they call these small
// functions and get plain results back. If the auth provider ever
// changes, only this file changes.
// SECURITY: nothing here "protects" data. Who can see what is decided by
// the database (05_customer_accounts.sql) using the signed-in user's
// identity — this file only asks.
// FUTURE: saved addresses, re-order and loyalty points plug in here.

const PENDING_CLAIM_KEY = "item_cart_pending_claim";

export const MIN_PASSWORD_LENGTH = 8;

// ---------- session ----------

export async function getSession() {
  if (!isBackendConfigured) return null;
  try {
    const supabase = await getSupabase();
    const { data } = await supabase.auth.getSession();
    return data.session;
  } catch (error) {
    console.warn("Item cart: could not read the session.", error);
    return null;
  }
}

export async function onAuthChange(callback) {
  const supabase = await getSupabase();
  // Keep the callback light — don't call Supabase from inside it.
  supabase.auth.onAuthStateChange((event) => callback(event));
}

// ---------- sign up / in / out ----------

export async function signUp({ fullName, phone, email, password }) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, phone },
        emailRedirectTo: new URL("account.html", window.location.href).href,
      },
    });
    if (error) return { ok: false, error: friendlyAuthError(error) };

    // Supabase hides "this email already exists" for privacy by returning a
    // fake user with no identities. Tell the person plainly instead.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return { ok: false, error: "An account with this email already exists. Try signing in instead." };
    }
    // No session = the project requires email confirmation first.
    return { ok: true, needsConfirmation: !data.session };
  } catch (error) {
    return { ok: false, error: friendlyAuthError(error) };
  }
}

export async function signIn({ email, password }) {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: friendlyAuthError(error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyAuthError(error) };
  }
}

export async function signOut() {
  const supabase = await getSupabase();
  await supabase.auth.signOut();
}

export async function requestPasswordReset(email) {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: new URL("account.html", window.location.href).href,
    });
    if (error) return { ok: false, error: friendlyAuthError(error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyAuthError(error) };
  }
}

export async function setNewPassword(password) {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { ok: false, error: friendlyAuthError(error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyAuthError(error) };
  }
}

// ---------- profile ----------

export async function getProfile(userId) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (error) {
    console.warn("Item cart: could not load the profile.", error);
    return null;
  }
}

export async function saveProfile(userId, { fullName, phone }) {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase
      .from("profiles")
      .upsert({ user_id: userId, full_name: fullName || null, phone: phone || null }, { onConflict: "user_id" });
    if (error) return { ok: false, error: friendlyAuthError(error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyAuthError(error) };
  }
}

// ---------- orders ----------

export async function getMyOrders() {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc("get_my_orders");
    if (error) throw error;
    return { ok: true, orders: data || [] };
  } catch (error) {
    console.warn("Item cart: could not load order history.", error);
    return { ok: false, orders: [] };
  }
}

export async function claimOrder(transactionId, phone) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc("claim_guest_orders", { p_transaction_id: transactionId, p_phone: phone });
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.warn("Item cart: could not save the order to the account.", error);
    return false;
  }
}

// A guest who just checked out is remembered in this browser, so the
// order lands in their account the moment they create or sign in to one —
// even if they confirm their email in another tab. It is forgotten as
// soon as it has been saved.
export function rememberGuestCheckout(transactionId, phone) {
  try {
    localStorage.setItem(PENDING_CLAIM_KEY, JSON.stringify({ transactionId, phone }));
  } catch (error) {
    console.warn("Item cart: could not remember the guest checkout.", error);
  }
}

export async function claimPendingCheckout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PENDING_CLAIM_KEY) || "null");
  } catch (error) {
    saved = null;
  }
  if (!saved || !saved.transactionId || !saved.phone) return false;

  const ok = await claimOrder(saved.transactionId, saved.phone);
  if (ok) localStorage.removeItem(PENDING_CLAIM_KEY);
  return ok;
}

// ---------- errors ----------

export function friendlyAuthError(error) {
  const msg = (error && error.message) || "";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email first. Check your inbox for the link we sent.";
  if (/already registered|already been registered/i.test(msg)) return "An account with this email already exists. Try signing in instead.";
  if (/password.*(at least|short|weak)|weak password/i.test(msg)) return `Choose a stronger password (at least ${MIN_PASSWORD_LENGTH} characters).`;
  if (/rate limit|too many|security purposes/i.test(msg)) return "Too many attempts. Please wait a minute and try again.";
  if (/same password|different from the old/i.test(msg)) return "Choose a password you haven't used before.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach the server. Check your internet connection and try again.";
  if (/valid email|invalid.*email/i.test(msg)) return "Enter a valid email address.";
  return "Something went wrong. Please try again.";
}
