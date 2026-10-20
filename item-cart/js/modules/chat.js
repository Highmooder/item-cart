import { getSupabase, isBackendConfigured } from "./backend.js";

// WHAT: everything the site needs for customer ⇄ vendor chat — list
// conversations, read and send messages, and live updates.
// WHY: pages call these small functions and get {ok, data, error} back, so
// they never touch Supabase directly.
// SECURITY: the phone-number hiding happens in the DATABASE
// (06_chat.sql → mask_contact_details). The check in this file is only a
// friendly heads-up while typing; it can't be used to bypass anything.
// FUTURE: photos, "report message", and WhatsApp/email alerts for vendors.

export const MAX_MESSAGE_LENGTH = 1000;
export { isBackendConfigured };

// ---------- friendly typing hint (mirrors the database filter) ----------

const NUMBER_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const DIGIT_RUN = /\+?\(?\d[\d\s().\-]{7,}\d/g;
const WORD_RUN = new RegExp(`\\b${NUMBER_WORD}(?:[\\s,.\\-]+${NUMBER_WORD}){7,}\\b`, "i");

export function looksLikePhoneNumber(text) {
  const normalized = String(text ?? "").replace(/(?<=\d)[oO](?=\d)/g, "0");
  const runs = normalized.match(DIGIT_RUN) || [];
  if (runs.some((run) => run.replace(/\D/g, "").length >= 10)) return true;
  return WORD_RUN.test(normalized);
}

// ---------- calls ----------

async function rpc(name, args) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { ok: false, error: friendlyChatError(error) };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: friendlyChatError(error) };
  }
}

export async function getMyVendors() {
  const result = await rpc("get_my_vendors");
  return result.ok ? result.data || [] : [];
}

// vendorId = null → the signed-in customer's own chats; otherwise that store's inbox
export function listConversations(vendorId) {
  return vendorId ? rpc("get_vendor_conversations", { p_vendor_id: vendorId }) : rpc("get_my_conversations");
}

export async function getMessages(conversationId) {
  try {
    const supabase = await getSupabase();
    const read = (columns) =>
      supabase.from("messages").select(columns).eq("conversation_id", conversationId).order("id", { ascending: true }).limit(500);

    // "attachment_path" only exists once 16_support_chat_and_receipts.sql is run.
    // Until then, ask without it so ordinary chat keeps working.
    let { data, error } = await read("id, sender_role, body, flagged, created_at, attachment_path");
    if (error) ({ data, error } = await read("id, sender_role, body, flagged, created_at"));
    if (error) return { ok: false, error: friendlyChatError(error) };
    return { ok: true, data: data || [] };
  } catch (error) {
    return { ok: false, error: friendlyChatError(error) };
  }
}

export function sendMessage(conversationId, body) {
  return rpc("send_message", { p_conversation_id: conversationId, p_body: body });
}

// ---------- receipt photos (customer -> Item cart Admin) ----------
// The photo goes into a private bucket, in a folder named after the signed-in
// customer. Only that customer and the Item cart Admin team can open it.
export const RECEIPT_BUCKET = "chat-receipts";

export async function uploadReceipt(file) {
  try {
    const supabase = await getSupabase();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData && userData.user && userData.user.id;
    if (!userId) return { ok: false, error: "Your session expired. Please sign in again." };

    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (error) {
      if (/bucket not found/i.test(error.message || "")) return { ok: false, error: "Receipt upload isn't set up yet. Please try again later." };
      return { ok: false, error: "We couldn't upload that photo. Check your connection and try again." };
    }
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: friendlyChatError(error) };
  }
}

export function sendReceipt(conversationId, body, path) {
  return rpc("send_receipt", { p_conversation_id: conversationId, p_body: body, p_path: path });
}

// Short-lived links for the receipt photos in a conversation. Returns { [path]: url }.
export async function getReceiptUrls(paths) {
  if (!paths.length) return {};
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrls(paths, 60 * 60);
    if (error || !data) return {};
    const urls = {};
    data.forEach((row) => {
      if (row.path && row.signedUrl) urls[row.path] = row.signedUrl;
    });
    return urls;
  } catch (error) {
    return {};
  }
}

export function startConversation(vendorId, body) {
  return rpc("start_conversation", { p_vendor_id: vendorId, p_body: body });
}

// A vendor's FIRST message to a customer, tied to a paid order they placed
// (10_vendor_orders.sql). After that, both sides use sendMessage.
export function startOrderConversation(orderId, body) {
  return rpc("vendor_start_order_conversation", { p_order_id: orderId, p_body: body });
}

export function markRead(conversationId) {
  return rpc("mark_conversation_read", { p_conversation_id: conversationId });
}

// New messages appear instantly when Realtime is on (see 06_chat.sql, section 8).
// Returns a function that stops listening. If Realtime isn't available the
// page's regular refresh still keeps the chat up to date.
export async function subscribeToThread(conversationId, onChange) {
  try {
    const supabase = await getSupabase();
    const channel = supabase
      .channel(`chat-${conversationId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, () => onChange())
      .subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch (error) {
        /* nothing to clean up */
      }
    };
  } catch (error) {
    console.warn("Item cart: live chat updates aren't available; the chat will refresh itself.", error);
    return () => {};
  }
}

// ---------- live signals: "is typing" and "Seen" ----------
// WHAT: two tiny live signals between the two people in a conversation:
//   "typing" - shows the dots on the other person's screen.
//   "read"   - tells the other person's screen to check whether their
//              messages have been seen (the ticks).
// Nothing is stored by the signals themselves. The truth about what has been
// read always comes from the database (getReadState); "read" is only a nudge
// to look again straight away instead of waiting for the next refresh.
// SECURITY: only the customer and the store's linked accounts of THAT
// conversation can join the channel typing-<conversation id>
// (database/14_typing_indicator.sql).
// FALLBACK: if that SQL hasn't been run, joining fails quietly: no dots, and
// the ticks update on the next refresh instead of instantly. Messages are not
// affected: they use their own channel.
const TYPING_SEND_EVERY_MS = 2500;

export async function joinLiveSignals(conversationId, myRole, { onTyping, onRead }) {
  const nobody = { notifyTyping() {}, notifyRead() {}, leave() {} };
  try {
    const supabase = await getSupabase();
    let ready = false;
    let lastTypingSent = 0;
    const send = (event) => {
      if (!ready) return;
      Promise.resolve(channel.send({ type: "broadcast", event, payload: { role: myRole } })).catch(() => {});
    };
    const fromTheOtherPerson = (payload) => payload && payload.role && payload.role !== myRole;
    const channel = supabase
      .channel(`typing-${conversationId}`, { config: { private: true, broadcast: { self: false } } })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (fromTheOtherPerson(payload)) onTyping();
      })
      .on("broadcast", { event: "read" }, ({ payload }) => {
        if (fromTheOtherPerson(payload)) onRead();
      })
      .subscribe((status) => {
        ready = status === "SUBSCRIBED";
      });
    return {
      // Call on every keystroke: it sends at most one signal every few seconds.
      notifyTyping() {
        const now = Date.now();
        if (!ready || now - lastTypingSent < TYPING_SEND_EVERY_MS) return;
        lastTypingSent = now;
        send("typing");
      },
      // Call right after you have marked the conversation read.
      notifyRead() {
        send("read");
      },
      leave() {
        try {
          supabase.removeChannel(channel);
        } catch (error) {
          /* nothing to clean up */
        }
      },
    };
  } catch (error) {
    return nobody;
  }
}

// When each side last read the conversation. A message you sent counts as
// "seen" once the OTHER side's time is later than the message's time.
// Both people may read the conversation row (06_chat.sql: "see own conversations").
export async function getReadState(conversationId) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from("conversations")
      .select("customer_last_read_at, vendor_last_read_at")
      .eq("id", conversationId)
      .maybeSingle();
    if (error || !data) return { ok: false };
    return { ok: true, data: { customer: data.customer_last_read_at, vendor: data.vendor_last_read_at } };
  } catch (error) {
    return { ok: false };
  }
}

// The same, for several conversations at once (the inbox list).
// Returns { ok, data: { [conversationId]: { customer, vendor } } }.
export async function getReadStates(conversationIds) {
  if (!conversationIds.length) return { ok: true, data: {} };
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from("conversations")
      .select("id, customer_last_read_at, vendor_last_read_at")
      .in("id", conversationIds);
    if (error || !data) return { ok: false };
    const byId = {};
    data.forEach((row) => {
      byId[row.id] = { customer: row.customer_last_read_at, vendor: row.vendor_last_read_at };
    });
    return { ok: true, data: byId };
  } catch (error) {
    return { ok: false };
  }
}

// ---------- errors ----------

export function friendlyChatError(error) {
  const msg = (error && error.message) || "";
  // P0001 = a message we wrote on purpose in the database function.
  if (error && error.code === "P0001" && msg) return msg;
  if (error && (error.code === "PGRST202" || /could not find the function|does not exist/i.test(msg))) return "Chat isn't set up yet. Please try again later.";
  if (/JWT|not authenticated|expired/i.test(msg)) return "Your session expired. Please sign in again.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach the server. Check your internet connection.";
  return "Something went wrong. Please try again.";
}
