// =====================================================================
// start-payment — begins an online payment, and checks one afterwards.
// =====================================================================
// Two actions, both called by the website:
//   "start"  → works out the fee, records the attempt, asks Paystack for a
//              checkout page and returns its address.
//   "verify" → asks Paystack directly whether this order was paid (used when
//              the customer returns to the site, so it works even if the
//              webhook is slow) and marks the order paid if so.
// WHO CAN CALL IT: anyone who could already open this order on the
//   confirmation page: the signed-in owner, or someone who knows the phone
//   number used at checkout. We check that by calling the same
//   get_confirmation database function the confirmation page uses.
// WHAT THE BROWSER CANNOT DO: it cannot choose the amount or the fee (both
//   are worked out here from your database), and it cannot mark an order
//   paid. Only Paystack's confirmation can, and only if the amount matches.
// SECRETS (Supabase → Edge Functions → Secrets): PAYSTACK_SECRET_KEY, SITE_URL,
//   optional ALLOWED_ORIGINS. SUPABASE_URL, SUPABASE_ANON_KEY and
//   SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// If PAYSTACK_SECRET_KEY is missing this answers "not_configured" and the
//   website quietly keeps offering manual payment only.
// SETUP: see database/PAYSTACK_SETUP.md
// FUTURE: refunds, and another provider if fees ever need to come down.
// =====================================================================

const PAYSTACK = "https://api.paystack.co";
const TIMEOUT_MS = 15000;
const IP_WINDOW_MS = 60_000;
const IP_MAX_PER_WINDOW = 20;

// ---------- the fee: MUST match js/modules/payments.js ----------
const RATE_PER_THOUSAND = 15; // 1.5%
const FLAT_FEE = 100;
const FLAT_STARTS_AT = 2500;
const FEE_CAP = 2000;

function feeTakenFrom(charge: number): number {
  const milli = RATE_PER_THOUSAND * charge + (charge >= FLAT_STARTS_AT ? FLAT_FEE * 1000 : 0);
  return Math.min(Math.floor((milli + 999) / 1000), FEE_CAP);
}

export function computeOnlineCharge(orderTotal: number): { charge: number; fee: number } {
  const total = Math.round(Number(orderTotal));
  if (!Number.isFinite(total) || total <= 0) return { charge: 0, fee: 0 };

  const net = (c: number) => c - feeTakenFrom(c);

  let c = Math.floor((total * 1000 + 984) / 985);
  while (c < FLAT_STARTS_AT && net(c) < total) c++;
  if (c < FLAT_STARTS_AT) return { charge: c, fee: c - total };

  c = Math.max(FLAT_STARTS_AT, Math.floor(((total + FLAT_FEE) * 1000 + 984) / 985));
  const uncappedNet = (x: number) => x - Math.floor((RATE_PER_THOUSAND * x + FLAT_FEE * 1000 + 999) / 1000);
  while (uncappedNet(c) < total) c++;
  while (c > FLAT_STARTS_AT && uncappedNet(c - 1) >= total) c--;
  c = Math.min(c, total + FEE_CAP);
  return { charge: c, fee: c - total };
}

// ---------- small helpers ----------
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
  if (hits.size > 500) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
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

// ---------- talking to your database (REST, no extra libraries) ----------
type Db = { url: string; anon: string; service: string };

// Same lookup the confirmation page uses, made WITH THE CALLER'S OWN LOGIN,
// so it only returns the order if they are allowed to see it.
async function getConfirmationAsCaller(db: Db, callerAuth: string, transactionId: string, phone: string | null) {
  const res = await timedFetch(`${db.url}/rest/v1/rpc/get_confirmation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: db.anon, Authorization: callerAuth || `Bearer ${db.anon}` },
    body: JSON.stringify({ p_transaction_id: transactionId, p_phone: phone }),
  });
  if (!res.ok) throw new Error(`get_confirmation ${res.status}`);
  return await res.json(); // null when not found / not theirs
}

async function serviceRpc(db: Db, name: string, args: Record<string, unknown>) {
  const res = await timedFetch(`${db.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: db.service, Authorization: `Bearer ${db.service}` },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err: any = new Error(`${name} ${res.status}`);
    err.dbMessage = body?.message || "";
    throw err;
  }
  return body;
}

async function getAttemptInfo(db: Db, transactionId: string) {
  const res = await timedFetch(
    `${db.url}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}&select=payment_attempts`,
    { headers: { apikey: db.service, Authorization: `Bearer ${db.service}` } },
  );
  if (!res.ok) throw new Error(`transactions ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? Number(rows[0].payment_attempts) || 0 : 0;
}

// ---------- talking to Paystack ----------
async function paystack(path: string, secret: string, init: RequestInit = {}) {
  const res = await timedFetch(`${PAYSTACK}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// ---------- the two actions ----------
async function startPayment(db: Db, secret: string, siteUrl: string, tx: any, cors: Record<string, string>) {
  const { charge, fee } = computeOnlineCharge(tx.total);
  if (charge <= 0) return json({ error: "nothing_to_pay" }, 400, cors);

  let begun: any;
  try {
    begun = await serviceRpc(db, "begin_online_payment", { p_transaction_id: tx.id, p_fee: fee });
  } catch (err: any) {
    if (err.dbMessage === "ALREADY_PAID") return json({ error: "already_paid" }, 409, cors);
    console.error("start-payment: could not record the attempt:", err.message);
    return json({ error: "failed" }, 500, cors);
  }
  if (Number(begun.total) !== Number(tx.total)) return json({ error: "failed" }, 409, cors); // changed under us

  const init = await paystack("/transaction/initialize", secret, {
    method: "POST",
    body: JSON.stringify({
      email: begun.email,
      amount: charge * 100, // Paystack counts in kobo
      currency: "NGN",
      reference: begun.reference,
      callback_url: `${siteUrl.replace(/\/+$/, "")}/confirmation.html?txn=${encodeURIComponent(tx.id)}`,
      metadata: { transactionId: tx.id, orderTotal: tx.total, paymentFee: fee, source: "item-cart" },
    }),
  });

  const url = init.body?.data?.authorization_url;
  if (!init.ok || init.body?.status !== true || typeof url !== "string") {
    console.error("start-payment: Paystack refused to start a payment, status", init.status);
    return json({ error: "provider_error" }, 502, cors);
  }
  return json({ authorizationUrl: url, reference: begun.reference, charge, fee }, 200, cors);
}

// Looks at the latest few attempts, because a customer may pay an earlier one.
async function verifyPayment(db: Db, secret: string, tx: any, cors: Record<string, string>) {
  const attempts = await getAttemptInfo(db, tx.id);
  if (attempts < 1) return json({ status: "pending" }, 200, cors);

  for (let n = attempts; n >= Math.max(1, attempts - 2); n--) {
    const ref = `${tx.id}-${n}`;
    const check = await paystack(`/transaction/verify/${encodeURIComponent(ref)}`, secret);
    const data = check.body?.data;
    if (!check.ok || check.body?.status !== true || !data) continue;
    if (data.status !== "success" || data.currency !== "NGN" || data.reference !== ref) continue;

    const result = await serviceRpc(db, "mark_transaction_paid", { p_reference: ref, p_amount_kobo: data.amount });
    if (result?.status === "paid" || result?.status === "already_paid") return json({ status: "paid" }, 200, cors);
    if (result?.status === "amount_mismatch") {
      console.error("start-payment: amount mismatch on", tx.id);
      return json({ status: "review" }, 200, cors);
    }
  }
  return json({ status: "pending" }, 200, cors);
}

// ---------- the request handler ----------
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
  const action = body?.action;
  const transactionId = typeof body?.transactionId === "string" ? body.transactionId : "";
  const phone = typeof body?.phone === "string" && body.phone.length <= 30 ? body.phone : null;
  if ((action !== "start" && action !== "verify") || !/^TXN-\d{1,12}$/.test(transactionId)) {
    return json({ error: "bad_request" }, 400, cors);
  }

  const secret = env("PAYSTACK_SECRET_KEY");
  const siteUrl = env("SITE_URL");
  const db: Db = { url: (env("SUPABASE_URL") || "").replace(/\/+$/, ""), anon: env("SUPABASE_ANON_KEY") || "", service: env("SUPABASE_SERVICE_ROLE_KEY") || "" };
  if (!secret || !db.url || !db.anon || !db.service || (action === "start" && !siteUrl)) {
    return json({ error: "not_configured" }, 503, cors);
  }

  try {
    const tx = await getConfirmationAsCaller(db, req.headers.get("authorization") || "", transactionId, phone);
    if (!tx) return json({ error: "not_found" }, 404, cors);

    if (tx.paymentStatus === "paid") {
      return action === "start" ? json({ error: "already_paid" }, 409, cors) : json({ status: "paid" }, 200, cors);
    }
    return action === "start" ? await startPayment(db, secret, siteUrl as string, tx, cors) : await verifyPayment(db, secret, tx, cors);
  } catch (err) {
    const reason = (err as Error)?.name === "AbortError" ? "timeout" : (err as Error)?.message;
    console.error("start-payment: failed:", reason); // never logs customer details
    return json({ error: "failed" }, 500, cors);
  }
}

if ((globalThis as any).Deno?.serve) {
  (globalThis as any).Deno.serve(handle);
}
