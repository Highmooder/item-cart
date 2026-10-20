// =====================================================================
// refund-payment — refunds an online (Paystack) payment from the admin page.
// =====================================================================
// WHAT: the admin taps "Refund" on a paid order (or on one vendor order
//       inside it). This asks Paystack to send the money back, then records
//       it and cancels the refunded vendor order(s).
// WHO CAN CALL IT: signed-in ADMINS only. We ask your database
//       (is_admin()) using the caller's own login, so a customer, a vendor
//       or an anonymous visitor gets "admins_only". The refund amount is
//       worked out by your database, never by the browser.
// SAFETY AGAINST DOUBLE REFUNDS: the database locks the payment for 2
//       minutes before Paystack is asked, so two admins (or a double tap)
//       can't both refund. If Paystack refuses, the lock is released and
//       nothing changes.
// IF THE SITE CAN'T RECORD A REFUND PAYSTACK ACCEPTED: you are told plainly
//       and the lock stays for 2 minutes. The money has been refunded, so
//       DON'T refund again; fix the record by hand in Admin.
// SECRETS: PAYSTACK_SECRET_KEY (same as start-payment), optional
//       ALLOWED_ORIGINS. SUPABASE_URL, SUPABASE_ANON_KEY and
//       SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// SETTING: leave "Verify JWT" ON (admins are signed in).
// SETUP: see database/PAYOUTS_AND_REFUNDS_SETUP.md
// =====================================================================

const PAYSTACK = "https://api.paystack.co";
const TIMEOUT_MS = 20000;
const IP_WINDOW_MS = 60_000;
const IP_MAX_PER_WINDOW = 10;
const RECORD_RETRIES = 3;

function env(key: string): string | undefined {
  try {
    const d = (globalThis as any).Deno;
    if (d?.env) return d.env.get(key) ?? undefined;
  } catch (_) { /* no permission: fall through */ }
  return (globalThis as any).__ENV?.[key];
}

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (env("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string, now = Date.now()): boolean {
  if (hits.size > 200) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > IP_MAX_PER_WINDOW;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type Db = { url: string; anon: string; service: string };

async function serviceRpc(db: Db, name: string, args: Record<string, unknown>) {
  const res = await timedFetch(`${db.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: db.service, Authorization: `Bearer ${db.service}` },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err: any = new Error(`${name} ${res.status}`);
    err.dbMessage = typeof body?.message === "string" ? body.message : "";
    throw err;
  }
  return body;
}

// Asks the database "is the person holding this login an admin?"
async function callerIsAdmin(db: Db, callerAuth: string): Promise<boolean> {
  if (!callerAuth) return false;
  const res = await timedFetch(`${db.url}/rest/v1/rpc/is_admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: db.anon, Authorization: callerAuth },
    body: "{}",
  });
  if (!res.ok) return false;
  return (await res.json().catch(() => false)) === true;
}

// The login token's "sub" is the admin's user id (the platform has already
// verified the token). Only used to note who did it; null if unreadable.
function adminIdFrom(callerAuth: string): string | null {
  try {
    const token = callerAuth.replace(/^Bearer\s+/i, "");
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(payload)).sub;
    return typeof sub === "string" && /^[0-9a-f-]{36}$/i.test(sub) ? sub : null;
  } catch (_) {
    return null;
  }
}

// A short, safe version of Paystack's own message to show the admin.
function safeMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "") // drop any HTML tags entirely
    .replace(/[^\p{L}\p{N}\s.,'()\-:]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handle(req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json({ error: "slow_down" }, 429, cors);

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "bad_request" }, 400, cors);
  }
  const transactionId = typeof body?.transactionId === "string" ? body.transactionId : "";
  const orderId = body?.orderId === null || body?.orderId === undefined ? null : typeof body.orderId === "string" ? body.orderId : "";
  if (!/^TXN-\d{1,12}$/.test(transactionId) || orderId === "" || (orderId !== null && !/^[A-Za-z0-9-]{1,40}$/.test(orderId))) {
    return json({ error: "bad_request" }, 400, cors);
  }

  const secret = env("PAYSTACK_SECRET_KEY");
  const db: Db = { url: (env("SUPABASE_URL") || "").replace(/\/+$/, ""), anon: env("SUPABASE_ANON_KEY") || "", service: env("SUPABASE_SERVICE_ROLE_KEY") || "" };
  if (!secret || !db.url || !db.anon || !db.service) return json({ error: "not_configured" }, 503, cors);

  const callerAuth = req.headers.get("authorization") || "";

  try {
    if (!(await callerIsAdmin(db, callerAuth))) return json({ error: "admins_only" }, 403, cors);

    // 1. The database checks it is allowed, works out the amount, and locks the payment.
    let prepared: any;
    try {
      prepared = await serviceRpc(db, "prepare_refund", { p_transaction_id: transactionId, p_order_id: orderId });
    } catch (err: any) {
      if (err.dbMessage === "NOT_ONLINE") return json({ error: "not_online" }, 400, cors);
      return json({ error: "refused", message: safeMessage(err.dbMessage) || "This refund isn't allowed." }, 409, cors);
    }
    const amount = Number(prepared.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      await serviceRpc(db, "abort_refund", { p_transaction_id: transactionId }).catch(() => null);
      return json({ error: "failed" }, 500, cors);
    }

    // 2. Ask Paystack to send the money back.
    let refund: { ok: boolean; status: number; body: any };
    try {
      const res = await timedFetch(`${PAYSTACK}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: prepared.reference,
          amount: amount * 100, // kobo
          currency: "NGN",
          customer_note: `Refund for order ${transactionId}`,
          merchant_note: "Refunded by Item cart admin",
        }),
      });
      refund = { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      // Couldn't reach Paystack at all: nothing was refunded, so release the lock.
      await serviceRpc(db, "abort_refund", { p_transaction_id: transactionId }).catch(() => null);
      console.error("refund-payment: could not reach Paystack:", (err as Error)?.name);
      return json({ error: "provider_unreachable" }, 502, cors);
    }

    if (!refund.ok || refund.body?.status !== true || !refund.body?.data) {
      await serviceRpc(db, "abort_refund", { p_transaction_id: transactionId }).catch(() => null);
      console.error("refund-payment: Paystack refused, status", refund.status);
      return json({ error: "provider_refused", message: safeMessage(refund.body?.message) }, 502, cors);
    }

    // 3. Paystack accepted: record it (retry a few times, because the money has moved).
    const data = refund.body.data;
    const providerId = String(data.id ?? data.refund_reference ?? "");
    const providerStatus = typeof data.status === "string" ? data.status : "pending";
    let recorded: any = null;
    for (let attempt = 1; attempt <= RECORD_RETRIES && !recorded; attempt++) {
      try {
        recorded = await serviceRpc(db, "finish_refund", {
          p_transaction_id: transactionId,
          p_order_id: orderId,
          p_amount: amount,
          p_provider_refund_id: providerId,
          p_provider_status: providerStatus,
          p_admin: adminIdFrom(callerAuth),
        });
      } catch (err: any) {
        console.error("refund-payment: could not record the refund, try", attempt, err.message);
        if (attempt < RECORD_RETRIES) await sleep(400 * attempt);
      }
    }
    if (!recorded) {
      return json({ error: "recorded_failed", amount, message: "Paystack accepted the refund but the site couldn't record it. Do NOT refund again." }, 500, cors);
    }

    return json({ ok: true, amount, providerStatus, paymentStatus: recorded.paymentStatus, refundedAmount: recorded.refundedAmount }, 200, cors);
  } catch (err) {
    console.error("refund-payment: failed:", (err as Error)?.name === "AbortError" ? "timeout" : (err as Error)?.message);
    return json({ error: "failed" }, 500, cors);
  }
}

if ((globalThis as any).Deno?.serve) {
  (globalThis as any).Deno.serve(handle);
}
