import { getSupabase } from "./backend.js";

// WHAT: what is unread, and where the person should be sent to read it.
// WHY: the header's Messages icon and the Messages page both need to know
// WHICH chat is unread, not just how many messages there are.
// Needs database/15_unread_chats.sql. Without it we fall back to the plain
// total (07_alerts.sql) and the icon opens the Messages page.

// Returns { total, chats } or null if the database can't be reached.
// chats = [{ id, vendorId, role: "customer" | "vendor", name, unread }, ...]
// (role = which side of the chat the signed-in person is), or null when
// 15_unread_chats.sql hasn't been run.
export async function fetchUnread() {
  try {
    const supabase = await getSupabase();

    const list = await supabase.rpc("get_unread_chats");
    if (!list.error && Array.isArray(list.data)) {
      const chats = list.data;
      return { total: chats.reduce((sum, chat) => sum + Number(chat.unread || 0), 0), chats };
    }

    const count = await supabase.rpc("get_unread_count");
    if (!count.error && typeof count.data === "number") return { total: count.data, chats: null };
  } catch (error) {
    /* the caller just tries again later */
  }
  return null;
}

// One unread chat: open that chat. Several chats in the same inbox: open that
// inbox. Anything else: the Messages page, where each unread chat is marked.
export function unreadLink(chats) {
  if (!chats || !chats.length) return "messages.html";
  const first = chats[0];
  const store = first.role === "vendor" ? `as=${encodeURIComponent(first.vendorId)}` : "";

  if (chats.length === 1) {
    return `messages.html?c=${encodeURIComponent(first.id)}${store ? `&${store}` : ""}`;
  }
  const sameInbox = chats.every((chat) => chat.role === first.role && chat.vendorId === first.vendorId) || chats.every((chat) => chat.role === "customer");
  if (!sameInbox) return "messages.html";
  return store ? `messages.html?${store}` : "messages.html";
}
