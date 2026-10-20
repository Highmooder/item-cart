// =====================================================================
// Item cart — email alerts for new chat messages (Supabase Edge Function)
// =====================================================================
// WHAT: when a new row is added to the messages table, a Database Webhook
// calls this function. It emails the person who should read the message
// (the vendor's linked accounts, or the customer), and — if you set
// ADMIN_ALERT_EMAIL — emails you when a phone number was flagged.
// WHY: vendors and customers aren't always on the site. Without this,
// a message sits unread until they happen to open Item cart.
// SAFE BY DESIGN:
//   * Only requests carrying your secret (x-webhook-secret) are accepted.
//   * The email contains the HIDDEN version of the message (the database
//     already removed any phone number), never the original.
//   * At most one email per person per conversation every 10 minutes.
// SETUP: see ALERTS_SETUP.md. Secrets needed: WEBHOOK_SECRET,
// RESEND_API_KEY, SITE_URL. Optional: FROM_EMAIL, ADMIN_ALERT_EMAIL.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// FUTURE: swap sendEmail() for WhatsApp/SMS without touching the rest.

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const MIN_GAP_MINUTES = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const env = (key: string): string => Deno.env.get(key) ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ---- talking to Supabase (plain fetch, service key) ----
async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) throw new Error(`Supabase request failed (${res.status}) for ${path.split("?")[0]}`);
  return res.status === 204 ? null : await res.json();
}

async function getUserEmail(userId: string): Promise<string | null> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_URL")}/auth/v1/admin/users/${userId}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.email === "string" ? user.email : null;
}

// ---- sending ----
async function sendEmail(to: string, subject: string, text: string, html: string): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("FROM_EMAIL") || "Item cart <onboarding@resend.dev>", to: [to], subject, text, html }),
  });
  if (!res.ok) console.error(`Email to ${to} failed (${res.status})`);
  return res.ok;
}

function emailBody(heading: string, preview: string, link: string, buttonLabel: string) {
  const text = `${heading}\n\n"${preview}"\n\n${buttonLabel}: ${link}\n\nYou are getting this because you have an Item cart account.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#131a16">
    <h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
    <p style="padding:12px 16px;background:#f4f1ea;border-radius:8px;white-space:pre-wrap">${escapeHtml(preview)}</p>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1f6f4a;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>
    <p style="font-size:12px;color:#6b756f">You are getting this because you have an Item cart account.</p></div>`;
  return { text, html };
}

// True if we already emailed this person about this conversation recently.
async function recentlyNotified(conversationId: string, recipientId: string): Promise<boolean> {
  const rows = await rest(`chat_notifications?conversation_id=eq.${conversationId}&recipient_id=eq.${recipientId}&select=last_sent_at`);
  if (!rows?.length) return false;
  return Date.now() - new Date(rows[0].last_sent_at).getTime() < MIN_GAP_MINUTES * 60 * 1000;
}

async function markNotified(conversationId: string, recipientId: string): Promise<void> {
  await rest("chat_notifications?on_conflict=conversation_id,recipient_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ conversation_id: conversationId, recipient_id: recipientId, last_sent_at: new Date().toISOString() }),
  });
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const secret = env("WEBHOOK_SECRET");
  if (!secret || req.headers.get("x-webhook-secret") !== secret) return json({ error: "Unauthorized." }, 401);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const message = payload?.record;
  if (payload?.type !== "INSERT" || payload?.table !== "messages" || !message) return json({ skipped: "Not a new message." });
  if (!UUID_RE.test(String(message.conversation_id))) return json({ error: "Bad conversation id." }, 400);

  const site = env("SITE_URL").replace(/\/+$/, "");
  const result = { sent: 0, skipped: 0, failed: 0 };
  const preview = String(message.body ?? "").slice(0, 200);

  const [conversation] = await rest(`conversations?id=eq.${message.conversation_id}&select=id,customer_id,vendor_id`);
  if (!conversation) return json({ skipped: "Conversation not found." });

  const [vendor] = await rest(`vendors?id=eq.${encodeURIComponent(conversation.vendor_id)}&select=store_name`);
  const vendorName: string = vendor?.store_name ?? "A vendor";

  // ---- who should be told? ----
  const alerts: { userId: string; subject: string; heading: string; link: string; button: string }[] = [];

  if (message.sender_role === "customer") {
    const [profile] = await rest(`profiles?user_id=eq.${conversation.customer_id}&select=full_name`);
    const customerName: string = String(profile?.full_name ?? "A customer").trim().split(/\s+/)[0] || "A customer";
    const members = await rest(`vendor_members?vendor_id=eq.${encodeURIComponent(conversation.vendor_id)}&select=user_id`);
    for (const member of members ?? []) {
      alerts.push({
        userId: member.user_id,
        subject: `New message from ${customerName} on Item cart`,
        heading: `${customerName} sent ${vendorName} a message`,
        link: `${site}/messages.html?as=${encodeURIComponent(conversation.vendor_id)}&c=${conversation.id}`,
        button: "Open your inbox",
      });
    }
  } else {
    alerts.push({
      userId: conversation.customer_id,
      subject: `${vendorName} replied to you on Item cart`,
      heading: `${vendorName} replied to your message`,
      link: `${site}/messages.html?c=${conversation.id}`,
      button: "Read the reply",
    });
  }

  for (const alert of alerts) {
    try {
      if (await recentlyNotified(conversation.id, alert.userId)) {
        result.skipped++;
        continue;
      }
      const email = await getUserEmail(alert.userId);
      if (!email) {
        result.skipped++;
        continue;
      }
      const { text, html } = emailBody(alert.heading, preview, alert.link, alert.button);
      if (await sendEmail(email, alert.subject, text, html)) {
        await markNotified(conversation.id, alert.userId);
        result.sent++;
      } else {
        result.failed++;
      }
    } catch (error) {
      console.error("Alert failed:", error);
      result.failed++;
    }
  }

  // ---- tell the admin when a phone number was flagged ----
  const adminEmail = env("ADMIN_ALERT_EMAIL");
  if (message.flagged && adminEmail) {
    try {
      const { text, html } = emailBody(
        `A phone number was hidden in a chat with ${vendorName}`,
        "Open the Chats tab in your admin page to see the original message.",
        `${site}/admin.html`,
        "Open admin"
      );
      if (await sendEmail(adminEmail, "Item cart: a phone number was flagged in chat", text, html)) result.sent++;
      else result.failed++;
    } catch (error) {
      console.error("Admin alert failed:", error);
      result.failed++;
    }
  }

  // Always answer 200 so the webhook doesn't retry (and double-send) over one bad address.
  return json(result);
}

Deno.serve(handle);
