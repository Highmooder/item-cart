// =====================================================================
// paystack-webhook — Paystack tells Item cart "this payment succeeded".
// =====================================================================
// WHAT: receives Paystack's "charge.success" message and marks the matching
//       order paid in your database. It also listens for refund updates
//       (refund.processed / refund.failed ...) so a refund that Paystack
//       later fails shows up in Admin instead of staying hidden.
// WHY:  this is the automatic part: no more checking payments by hand.
// WHY IT CAN BE TRUSTED:
//   * Every message carries a signature made with your secret key. We
//     recompute it and refuse anything that doesn't match, so nobody can
//     post a fake "payment succeeded".
//   * The database then checks the amount equals the order total plus the
//     fee, to the kobo (mark_transaction_paid in 11_online_payments.sql).
//   * Paystack may send the same message more than once. That is harmless:
//     a paid order stays paid and nothing else changes.
// IMPORTANT SETTING: Paystack does not send a Supabase login, so this
//   function must have "Verify JWT" switched OFF (Edge Functions → this
//   function → Details). The signature above is what protects it instead.
// SECRETS: PAYSTACK_SECRET_KEY (the same one start-payment uses).
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// SETUP: see database/PAYSTACK_SETUP.md
// =====================================================================

const TIMEOUT_MS = 10000;

function env(key: string): string | undefined {
  try {
    const d = (globalThis as any).Deno;
    if (d?.env) return d.env.get(key) ?? undefined;
  } catch (_) { /* no permission: fall through */ }
  return (globalThis as any).__ENV?.[key];
}

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// HMAC-SHA512 of the exact bytes Paystack sent, as lowercase hex.
export async function signBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
}

// Compares two strings without stopping at the first difference.
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const secret = env("PAYSTACK_SECRET_KEY");
  const dbUrl = (env("SUPABASE_URL") || "").replace(/\/+$/, "");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !dbUrl || !service) return reply({ error: "not_configured" }, 503);

  // Read the body EXACTLY as sent: the signature covers these exact bytes.
  const raw = await req.text();
  const given = (req.headers.get("x-paystack-signature") || "").toLowerCase();
  const expected = await signBody(secret, raw);
  if (!given || !sameString(given, expected)) return reply({ error: "bad_signature" }, 401);

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    return reply({ error: "bad_request" }, 400);
  }

  const data = event?.data;

  // Refund progress. The event NAME (covered by the signature) gives the status.
  const REFUND_EVENTS: Record<string, string> = {
    "refund.pending": "pending",
    "refund.processing": "processing",
    "refund.processed": "processed",
    "refund.failed": "failed",
    "refund.needs-attention": "needs-attention",
  };
  if (typeof event?.event === "string" && event.event in REFUND_EVENTS) {
    const reference = data?.transaction_reference ?? data?.transaction?.reference;
    const amountKobo = Number(data?.amount);
    if (typeof reference !== "string" || !Number.isFinite(amountKobo)) return reply({ ok: true, ignored: true }, 200);
    if (event.event === "refund.failed" || event.event === "refund.needs-attention") {
      console.error("paystack-webhook: a refund needs attention for", reference);
    }
    return await callDb(dbUrl, service, "record_refund_status", { p_transaction_reference: reference, p_amount_kobo: amountKobo, p_status: REFUND_EVENTS[event.event] });
  }

  // Only successful charges matter. Everything else is acknowledged and ignored.
  if (event?.event !== "charge.success" || data?.status !== "success" || data?.currency !== "NGN" || typeof data?.reference !== "string") {
    return reply({ ok: true, ignored: true }, 200);
  }

  const result = await callDb(dbUrl, service, "mark_transaction_paid", { p_reference: data.reference, p_amount_kobo: data.amount });
  return result;
}

// Calls one of the server-only database functions. A temporary failure answers
// with an error so Paystack sends the message again later.
async function callDb(dbUrl: string, service: string, fn: string, args: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${dbUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: service, Authorization: `Bearer ${service}` },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("paystack-webhook: database refused", fn, "status", res.status);
      return reply({ error: "try_again" }, 500);
    }
    const result = await res.json().catch(() => null);
    if (result?.status === "amount_mismatch") console.error("paystack-webhook: amount mismatch on a payment");
    return reply({ ok: true, status: result?.status ?? "unknown" }, 200);
  } catch (err) {
    console.error("paystack-webhook: could not reach the database:", (err as Error)?.name);
    return reply({ error: "try_again" }, 500);
  } finally {
    clearTimeout(timer);
  }
}

if ((globalThis as any).Deno?.serve) {
  (globalThis as any).Deno.serve(handle);
}
