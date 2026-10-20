import { getSupabase, isBackendConfigured } from "./backend.js";
import { hasStoredSession } from "./sessionHint.js";
import { fetchUnread, unreadLink } from "./unread.js";

// WHAT: in-app alerts for new chat messages — an unread badge on the
// Messages icon (and the Messages menu link), the page title count, and,
// if the person allowed it, a browser notification.
// WHY: people shouldn't have to open the Messages page to find out
// someone wrote to them.
// LIMIT: this only works while Item cart is open in a browser tab. Email
// alerts (07_alerts.sql + the Edge Function) cover the times it isn't.
// COST: nothing in this file is downloaded for visitors who aren't signed
// in (see sessionHint.js and layout.js).

const POLL_MS = 45000;
const DISMISSED_KEY = "item_cart_notify_dismissed";

export function browserNotificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

// Asks the browser for permission. Must be called from a click.
export async function enableBrowserNotifications() {
  if (!browserNotificationsSupported()) return "unsupported";
  const result = await Notification.requestPermission();
  return result;
}

export function shouldOfferNotifications() {
  if (!browserNotificationsSupported()) return false;
  if (Notification.permission !== "default") return false;
  try {
    return localStorage.getItem(DISMISSED_KEY) !== "1";
  } catch (error) {
    return true;
  }
}

export function dismissNotificationOffer() {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch (error) {
    /* ignore */
  }
}

// Pages that read messages tell us, so the badge clears straight away.
export function announceUnreadChanged() {
  window.dispatchEvent(new Event("item-cart:unread-changed"));
}

function paintBadges(count, href) {
  // The count sits on the Messages icon in the header, and that icon opens the
  // unread chat itself (href) instead of a general page.
  const badge = document.getElementById("messages-badge");
  if (badge) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.hidden = count === 0;
  }
  const messagesLink = document.getElementById("messages-link");
  if (messagesLink) {
    messagesLink.setAttribute("aria-label", count ? `Messages, ${count} unread ${count === 1 ? "message" : "messages"}` : "Messages");
    messagesLink.setAttribute("href", count ? href : "messages.html");
  }

  document.querySelectorAll('#nav-links a[href="messages.html"]').forEach((link) => {
    link.querySelector(".nav-pill")?.remove();
    if (count > 0) {
      const pill = document.createElement("span");
      pill.className = "nav-pill";
      pill.textContent = count > 9 ? "9+" : String(count);
      link.appendChild(pill);
    }
  });
}

export async function startNotifications() {
  if (!isBackendConfigured || !hasStoredSession()) return;

  let supabase;
  let userId;
  try {
    supabase = await getSupabase();
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    userId = data.session.user.id;
  } catch (error) {
    return;
  }

  const baseTitle = document.title;
  let unread = 0;
  let chats = null; // which chats are unread (needs 15_unread_chats.sql)

  const paint = () => {
    paintBadges(unread, unreadLink(chats));
    document.title = unread > 0 && document.visibilityState !== "visible" ? `(${unread}) ${baseTitle}` : baseTitle;
  };

  async function refresh() {
    try {
      const result = await fetchUnread();
      if (result) {
        unread = result.total;
        chats = result.chats;
        paint();
      }
    } catch (error) {
      /* try again on the next tick */
    }
  }

  async function notifyBrowser(row) {
    if (!browserNotificationsSupported() || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return; // they're looking at the site already

    const title = "New message on Item cart";
    const url = row && row.conversation_id ? `/messages.html?c=${encodeURIComponent(row.conversation_id)}` : "/messages.html";
    const options = {
      body: row && row.body ? String(row.body).slice(0, 120) : "You have a new message.",
      tag: "item-cart-message",
      icon: "/assets/icons/icon-192.png",
      data: { url },
    };

    // Android and the installed app only allow alerts through the service worker
    // (sw.js opens the chat when it is tapped).
    try {
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (registration) {
        await registration.showNotification(title, options);
        return;
      }
    } catch (error) {
      /* fall back to the plain alert below */
    }

    try {
      const note = new Notification(title, options);
      note.onclick = () => {
        window.focus();
        window.location.href = url;
      };
    } catch (error) {
      /* this browser doesn't allow page alerts */
    }
  }

  async function onNewMessage(payload) {
    const row = payload && payload.new;
    if (row && row.sender_id === userId) return; // my own message
    await refresh();
    notifyBrowser(row);
  }

  await refresh();

  try {
    supabase
      .channel("inbox-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, onNewMessage)
      .subscribe();
  } catch (error) {
    console.warn("Item cart: live message alerts aren't available; checking periodically instead.", error);
  }

  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", paint);
  window.addEventListener("item-cart:unread-changed", refresh);
}
