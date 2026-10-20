import { renderHeader, renderFooter } from "../modules/layout.js";
import { loadCatalog } from "../modules/catalog.js";
import { getVendorById } from "../data/vendors.js";
import { getProductById } from "../data/products.js";
import { escapeHtml as esc, attrUrl } from "../modules/escape.js";
import { icon } from "../modules/icons.js";
import { fetchUnread } from "../modules/unread.js";
import { getSession } from "../modules/auth.js";
import { shouldOfferNotifications, enableBrowserNotifications, dismissNotificationOffer, announceUnreadChanged } from "../modules/notifications.js";
import {
  isBackendConfigured,
  looksLikePhoneNumber,
  getMyVendors,
  listConversations,
  getMessages,
  sendMessage,
  startConversation,
  startOrderConversation,
  markRead,
  subscribeToThread,
  joinLiveSignals,
  getReadState,
  getReadStates,
  uploadReceipt,
  sendReceipt,
  getReceiptUrls,
} from "../modules/chat.js";
import { listOrders } from "../modules/vendorOrders.js";
import { ITEMCART_CONFIG } from "../data/config.js";
import { prepareImage, MAX_ORIGINAL_BYTES } from "../modules/imageResize.js";

// WHAT: the Messages page. An inbox of conversations, and a conversation
// view with a message box.
// WHO SEES WHAT: customers see their chats with vendors. A vendor (a
// signed-in account that you linked to a store in the admin page) can
// switch to that store's inbox. The database enforces this — the page
// only asks for what the signed-in person is allowed to see.
// URL: messages.html?vendor=<id> opens (or starts) a chat with a vendor;
//      messages.html?c=<id> opens a conversation;
//      messages.html?as=<vendor id> opens a store's inbox;
//      messages.html?order=<order id>&as=<vendor id> lets a store start a chat
//      with the customer who placed that (paid) order;
//      messages.html?vendor=runnit-admin&receipt=<transaction id> opens the chat
//      with Item cart Admin, where the customer attaches their bank-transfer receipt.

const REFRESH_MS = 20000;
// The dots disappear this long after the other person's last keystroke signal
// (their screen sends one every ~2.5 s while they type).
const TYPING_HIDE_MS = 4000;

const state = {
  vendors: [], // stores this person manages
  mode: null, // null = my chats as a customer, or a vendor id
  conversations: [],
  active: null, // { id|null, vendorId, title, image }
  messages: [],
  unsubscribe: null,
  live: null, // the live "typing" / "read" signals for the open conversation
  typingTimer: null,
  readState: null, // when each side last read the open conversation (for the "Seen" ticks)
  inboxReads: {}, // the same for every chat in the inbox list, by conversation id
  unreadByMode: {}, // unread count per inbox tab ("" = My chats, otherwise the store id)
  needsRead: false, // new messages arrived while the tab was hidden; mark them read when it is shown
  timer: null,
  sending: false,
  pendingReceipt: null, // the receipt photo picked but not sent yet
  receiptUrls: {}, // receipt photo path -> short-lived link
  receiptUrlsAt: 0,
};

const RECEIPT_CAPTION = "Payment receipt attached.";

const $ = (id) => document.getElementById(id);
const VIEWS = ["chat-loading", "chat-setup", "inbox-view", "thread-view"];

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("messages.html");
  renderFooter();

  if (!isBackendConfigured) {
    showView("chat-setup");
    return;
  }

  const session = await getSession();
  if (!session) {
    const next = "messages.html" + window.location.search;
    window.location.replace(`account.html?next=${encodeURIComponent(next)}`);
    return;
  }

  await loadCatalog();
  state.vendors = await getMyVendors();

  const params = new URLSearchParams(window.location.search);
  const as = params.get("as");
  state.mode = as && state.vendors.some((v) => v.id === as) ? as : null;

  wire();
  wireNotifyOffer();
  await refreshInbox();

  const conversationId = params.get("c");
  const vendorId = params.get("vendor");
  const orderId = params.get("order");
  if (conversationId) {
    let found = state.conversations.find((c) => c.id === conversationId);
    // A link from an alert may point at a store inbox the person didn't pick yet.
    if (!found && !as) {
      for (const store of state.vendors) {
        const result = await listConversations(store.id);
        const match = result.ok ? (result.data || []).find((c) => c.id === conversationId) : null;
        if (match) {
          state.mode = store.id;
          await refreshInbox();
          found = state.conversations.find((c) => c.id === conversationId);
          break;
        }
      }
    }
    if (found) return openConversation(found);
  } else if (vendorId && state.mode === null) {
    await openVendorChat(vendorId);
    prefillAboutProduct(params.get("ask"), vendorId);
    prefillReceipt(params.get("receipt"), vendorId);
    return;
  } else if (orderId && state.mode) {
    await openOrderChat(orderId);
    return;
  }
  showInbox();
});

function showView(id) {
  VIEWS.forEach((v) => ($(v).style.display = v === id ? "block" : "none"));
}

// ---------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------
function renderModes() {
  const el = $("chat-modes");
  if (!state.vendors.length) {
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  const tabs = [{ id: null, label: "My chats" }, ...state.vendors.map((v) => ({ id: v.id, label: `Inbox: ${v.storeName}` }))];
  el.innerHTML = tabs
    .map((t) => {
      const unread = state.unreadByMode[t.id ?? ""] || 0;
      const badge = unread ? ` <span class="conversation__badge" aria-label="${unread} unread">${unread}</span>` : "";
      return `<button type="button" role="tab" aria-selected="${t.id === state.mode}" data-mode="${esc(t.id ?? "")}">${esc(t.label)}${badge}</button>`;
    })
    .join("");
}

async function refreshInbox() {
  const result = await listConversations(state.mode);
  const errorEl = $("inbox-error");
  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.style.display = "block";
    return;
  }
  errorEl.style.display = "none";
  state.conversations = result.data || [];
  renderModes();
  renderConversationList();

  // The ticks and the tab counts need two more lookups. Show the list first,
  // then fill them in, so the inbox never waits for them.
  const modeAtStart = state.mode;
  loadInboxExtras().then(() => {
    if (state.mode !== modeAtStart) return;
    renderModes();
    renderConversationList();
  });
}

async function loadInboxExtras() {
  const role = state.mode ? "vendor" : "customer";
  const sentByMe = state.conversations.filter((c) => c.lastMessage && c.lastSenderRole === role).map((c) => c.id);
  const [reads, unread] = await Promise.all([getReadStates(sentByMe), fetchUnread()]);
  state.inboxReads = reads.ok ? reads.data : {};

  const byMode = {};
  ((unread && unread.chats) || []).forEach((chat) => {
    const key = chat.role === "vendor" ? chat.vendorId : "";
    byMode[key] = (byMode[key] || 0) + Number(chat.unread || 0);
  });
  state.unreadByMode = byMode;
}

function showInbox() {
  stopLive();
  state.active = null;
  state.messages = [];
  showView("inbox-view");
  history.replaceState({}, "", state.mode ? `messages.html?as=${encodeURIComponent(state.mode)}` : "messages.html");
  state.timer = setInterval(refreshInbox, REFRESH_MS);
}

function initial(name) {
  return esc(String(name || "?").trim().charAt(0).toUpperCase());
}

function avatar(image, name) {
  return image ? `<img src="${attrUrl(image)}" alt="" loading="lazy" data-initial="${initial(name)}" />` : initial(name);
}

// A picture that fails to load falls back to the first letter instead of a broken icon.
function wireAvatarFallbacks(root) {
  root.querySelectorAll("img[data-initial]").forEach((img) => {
    img.addEventListener("error", () => {
      img.parentElement.textContent = img.dataset.initial;
    });
  });
}

// ---- Times and dates: ONE set of helpers, used by the inbox and the thread ----
function clockTime(iso) {
  return new Date(iso).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" });
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// 0 = today, 1 = yesterday, and so on.
function daysAgo(iso) {
  return Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
}

// Inbox: the time for today's chats, then "Yesterday", then the date.
function shortTime(iso) {
  const days = daysAgo(iso);
  if (days === 0) return clockTime(iso);
  if (days === 1) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short" });
}

// Conversation: the label on the divider between days.
function dayLabel(iso) {
  const days = daysAgo(iso);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(iso);
  const options = { weekday: "short", day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return date.toLocaleDateString("en-NG", options);
}

function renderConversationList() {
  const el = $("conversation-list");
  if (!state.conversations.length) {
    el.innerHTML = state.mode
      ? `<div class="empty-state"><h3>No messages yet</h3><p style="margin-inline:auto">When customers message your store, their chats appear here.</p></div>`
      : `<div class="empty-state"><h3>No messages yet</h3><p style="margin-inline:auto">Open a vendor's page and tap Message to start a chat.</p><a href="vendors.html" class="btn btn-primary btn-sm">Browse vendors</a></div>`;
    return;
  }

  const myRole = state.mode ? "vendor" : "customer";
  el.innerHTML = state.conversations
    .map((c) => {
      const preview = c.lastMessage ? `${c.lastSenderRole === myRole ? "You: " : ""}${c.lastMessage}` : "No messages yet";
      return `
      <button type="button" class="conversation ${c.unread ? "conversation--unread" : ""}" data-conversation="${esc(c.id)}">
        <span class="chat-avatar">${avatar(c.image, c.name)}</span>
        <span>
          <span class="conversation__name">${esc(c.name)}</span>
          <span class="conversation__preview">${inboxTicks(c, myRole)}${esc(preview)}</span>
        </span>
        <span class="conversation__side">
          <span>${esc(shortTime(c.lastMessageAt))}</span>
          ${c.unread ? `<span class="conversation__badge" aria-label="${c.unread} unread">${c.unread}</span>` : ""}
        </span>
      </button>`;
    })
    .join("");
  wireAvatarFallbacks(el);
}

// ---------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------
function openVendorChat(vendorId) {
  const existing = state.conversations.find((c) => c.vendorId === vendorId);
  if (existing) return openConversation(existing);

  // The Item cart Admin inbox is hidden from the shop, so it has no vendor record to look up.
  if (vendorId === ITEMCART_CONFIG.supportVendorId) {
    return openThread({ id: null, vendorId, name: ITEMCART_CONFIG.supportName, image: null });
  }

  const vendor = getVendorById(vendorId);
  if (!vendor) {
    $("inbox-error").textContent = "That vendor isn't available right now.";
    $("inbox-error").style.display = "block";
    showInbox();
    return;
  }
  return openThread({ id: null, vendorId, name: vendor.storeName, image: vendor.image });
}

function openConversation(conversation) {
  return openThread(conversation);
}

// A store opens a chat from an order on the Orders page. The customer's name
// and whether they can be messaged come from the database (never from the
// address bar), and nothing is sent until the vendor presses Send.
async function openOrderChat(orderId) {
  const result = await listOrders(state.mode);
  const order = result.ok ? (result.data || []).find((o) => o.id === orderId) : null;

  if (!order) {
    $("inbox-error").textContent = result.ok ? "We couldn't find that order." : result.error;
    $("inbox-error").style.display = "block";
    return showInbox();
  }
  if (!order.canMessage) {
    $("inbox-error").textContent = "This customer ordered as a guest, so they can't receive chat messages.";
    $("inbox-error").style.display = "block";
    return showInbox();
  }

  // Already chatting with this customer? Continue that conversation.
  if (order.conversationId) {
    const existing = state.conversations.find((c) => c.id === order.conversationId);
    return openConversation(existing || { id: order.conversationId, vendorId: state.mode, name: order.customerName, image: null });
  }

  await openThread({ id: null, vendorId: state.mode, orderId: order.id, name: order.customerName, image: null });
  const store = state.vendors.find((v) => v.id === state.mode);
  const input = $("composer-input");
  if (store && input && !input.value) {
    input.value = `Hi, this is ${store.storeName} about your order ${order.id}. `;
    input.dispatchEvent(new Event("input"));
  }
}

async function openThread(conversation) {
  stopLive();
  state.active = { id: conversation.id, vendorId: conversation.vendorId, title: conversation.name, image: conversation.image, orderId: conversation.orderId || null };
  state.messages = [];
  state.readState = null;
  state.needsRead = false;
  setTyping(false);

  $("thread-title").textContent = conversation.name;
  $("thread-avatar").innerHTML = avatar(conversation.image, conversation.name);
  wireAvatarFallbacks($("thread-avatar"));
  $("composer-input").value = "";
  $("composer-warning").style.display = "none";
  $("composer-error").style.display = "none";
  $("thread-messages").dataset.fresh = "true";
  clearReceipt();
  $("composer-attach-row").style.display = isSupportChat() ? "flex" : "none";
  showView("thread-view");

  if (conversation.id) {
    history.replaceState({}, "", `messages.html?c=${encodeURIComponent(conversation.id)}${state.mode ? `&as=${encodeURIComponent(state.mode)}` : ""}`);
    await loadThread();
    startLive(conversation.id);
  } else if (conversation.orderId) {
    history.replaceState({}, "", `messages.html?order=${encodeURIComponent(conversation.orderId)}&as=${encodeURIComponent(conversation.vendorId)}`);
    renderThread();
  } else {
    history.replaceState({}, "", `messages.html?vendor=${encodeURIComponent(conversation.vendorId)}`);
    renderThread();
  }
  $("composer-input").focus();
}

async function startLive(conversationId) {
  state.unsubscribe = await subscribeToThread(conversationId, loadThread);
  state.timer = setInterval(loadThread, REFRESH_MS);

  const live = await joinLiveSignals(conversationId, myRole(), { onTyping: showTyping, onRead: refreshReadState });
  // They left this conversation while we were connecting: don't keep the channel open.
  if (!state.active || state.active.id !== conversationId) {
    live.leave();
    return;
  }
  state.live = live;
}

function stopLive() {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = null;
  if (state.live) state.live.leave();
  state.live = null;
  setTyping(false);
  clearInterval(state.timer);
  state.timer = null;
}

// ---- The other person's "is typing" dots ----
function showTyping() {
  if (!state.active) return;
  setTyping(true);
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => setTyping(false), TYPING_HIDE_MS);
}

function setTyping(on) {
  if (!on) clearTimeout(state.typingTimer);
  if (on && state.active) $("thread-typing-text").textContent = `${state.active.title} is typing…`;
  $("thread-typing").classList.toggle("is-visible", on);
}

async function loadThread() {
  const active = state.active;
  if (!active || !active.id) return;

  const [result, read] = await Promise.all([getMessages(active.id), getReadState(active.id)]);
  if (!state.active || state.active.id !== active.id) return; // they went elsewhere meanwhile
  if (!result.ok) {
    showComposerError(result.error);
    return;
  }
  if (read.ok) state.readState = read.data;

  await refreshReceiptUrls(result.data);
  if (!state.active || state.active.id !== active.id) return;

  const hadUnreadFromThem = result.data.some((m) => m.sender_role !== myRole() && !state.messages.some((x) => x.id === m.id));
  state.messages = result.data;
  if (hadUnreadFromThem) setTyping(false); // their message arrived, so they are no longer "typing"
  renderThread();
  if (hadUnreadFromThem) markThreadRead();
}

// ---- "Seen" ticks ----
// Marks the open conversation read, and nudges the other person's screen so
// their ticks turn to "Seen" straight away. Only while this tab is actually
// showing: a message that arrives in a hidden tab is NOT seen yet, so it is
// marked as soon as the person comes back to the tab.
function markThreadRead() {
  const active = state.active;
  if (!active || !active.id) return;
  if (document.visibilityState !== "visible") {
    state.needsRead = true;
    return;
  }
  state.needsRead = false;
  markRead(active.id).then(() => {
    announceUnreadChanged();
    if (state.live) state.live.notifyRead();
  });
}

// When the OTHER side last read this conversation (null = not yet).
function theirLastRead() {
  const read = state.readState;
  if (!read) return null;
  return myRole() === "customer" ? read.vendor : read.customer;
}

// The other person says they just read: check, and redraw only if it changed.
async function refreshReadState() {
  const active = state.active;
  if (!active || !active.id) return;
  const read = await getReadState(active.id);
  if (!read.ok || !state.active || state.active.id !== active.id) return;
  const before = theirLastRead();
  state.readState = read.data;
  if (theirLastRead() !== before) renderThread();
}

// One tick = sent, two ticks = seen. The words are for screen readers.
// The same ticks are used in the conversation (bubble__ticks) and in the
// inbox list (conversation__ticks).
function tickMarkup(seen, className) {
  return `<span class="${className}${seen ? ` ${className}--seen` : ""}">${icon(seen ? "checkDouble" : "check")}<span class="visually-hidden">${seen ? "Seen" : "Sent"}</span></span>`;
}

// "Seen" = the other side read the conversation after this was sent.
function hasSeen(theirLastReadAt, sentAt) {
  return Boolean(theirLastReadAt) && Date.parse(theirLastReadAt) >= Date.parse(sentAt);
}

function ticksFor(message) {
  return tickMarkup(hasSeen(theirLastRead(), message.created_at), "bubble__ticks");
}

// Inbox: a tick in front of the preview when the last message is yours.
function inboxTicks(conversation, role) {
  if (!conversation.lastMessage || conversation.lastSenderRole !== role) return "";
  const read = state.inboxReads[conversation.id];
  const theirs = read ? (role === "customer" ? read.vendor : read.customer) : null;
  return tickMarkup(hasSeen(theirs, conversation.lastMessageAt), "conversation__ticks");
}

function myRole() {
  return state.mode ? "vendor" : "customer";
}

function renderThread() {
  const el = $("thread-messages");
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  if (!state.messages.length) {
    el.innerHTML = isSupportChat()
      ? `<p class="thread__empty">Attach a photo of your bank-transfer receipt and send it to ${esc(state.active.title)}. Item cart will confirm your payment.</p>`
      : state.active.orderId
      ? `<p class="thread__empty">Message ${esc(state.active.title)} about order ${esc(state.active.orderId)}. Agree where and when to hand it over.</p>`
      : `<p class="thread__empty">Say hello to ${esc(state.active.title)}. Ask about a product, sizes or pickup.</p>`;
    return;
  }

  // A day divider whenever the date changes, and a message right after another
  // one from the same person sits closer to it, like every chat app.
  const html = [];
  let prev = null;
  state.messages.forEach((m) => {
    const mine = m.sender_role === myRole();
    const day = new Date(m.created_at).toDateString();
    const newDay = !prev || prev.day !== day;
    const stacked = prev && !newDay && prev.sender === m.sender_role && !prev.notice;
    const notice = mine && m.flagged;

    if (newDay) html.push(`<div class="thread__day">${esc(dayLabel(m.created_at))}</div>`);
    html.push(`<div class="bubble ${mine ? "bubble--mine" : "bubble--theirs"}${stacked ? " bubble--stacked" : ""}">${receiptImage(m)}${esc(m.body)}<span class="bubble__time">${esc(clockTime(m.created_at))}${mine ? ticksFor(m) : ""}</span></div>`);
    if (notice) html.push(`<p class="bubble__notice">We hid a phone number in this message. Please keep chats and payments on Item cart.</p>`);
    prev = { day, sender: m.sender_role, notice };
  });
  el.innerHTML = html.join("");

  if (nearBottom || el.dataset.fresh !== "false") {
    el.scrollTop = el.scrollHeight;
    el.dataset.fresh = "false";
  }
}

// ---------------------------------------------------------------------
// Receipt photos (chat with Item cart Admin)
// ---------------------------------------------------------------------
// Only a customer, in their chat with Item cart Admin, gets the attach button.
function isSupportChat() {
  return state.mode === null && Boolean(state.active) && state.active.vendorId === ITEMCART_CONFIG.supportVendorId;
}

// "?receipt=TXN-1001": start the message for them. They still press Send themselves.
function prefillReceipt(transactionId, vendorId) {
  if (vendorId !== ITEMCART_CONFIG.supportVendorId || !transactionId || !/^[A-Za-z0-9-]{3,30}$/.test(transactionId)) return;
  const input = $("composer-input");
  if (!input || input.value) return;
  input.value = `Payment receipt for ${transactionId}.`;
  input.dispatchEvent(new Event("input"));
}

function receiptImage(message) {
  if (!message.attachment_path) return "";
  const url = state.receiptUrls[message.attachment_path];
  if (!url) return `<span class="bubble__time">Receipt photo unavailable</span>`;
  return `<a class="bubble__image-link" href="${attrUrl(url)}" target="_blank" rel="noopener"><img class="bubble__image" src="${attrUrl(url)}" alt="Payment receipt" loading="lazy" /></a>`;
}

// Photos are private, so each is opened through a link that expires after an hour.
async function refreshReceiptUrls(messages) {
  const paths = [...new Set(messages.map((m) => m.attachment_path).filter(Boolean))];
  if (!paths.length) return;
  const stale = Date.now() - state.receiptUrlsAt > 50 * 60 * 1000;
  if (!stale && paths.every((path) => state.receiptUrls[path])) return;
  state.receiptUrls = { ...state.receiptUrls, ...(await getReceiptUrls(paths)) };
  state.receiptUrlsAt = Date.now();
}

function pickReceipt(file) {
  const error = $("composer-error");
  error.style.display = "none";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showComposerError("Please choose a photo or screenshot of your receipt.");
    return;
  }
  if (file.size > MAX_ORIGINAL_BYTES) {
    showComposerError("That photo is too large. Please choose one under 15 MB.");
    return;
  }
  state.pendingReceipt = file;
  $("composer-attachment-name").textContent = file.name || "Receipt photo";
  $("composer-attachment-remove").style.display = "";
  $("composer-attach").textContent = "Change photo";
}

function clearReceipt() {
  state.pendingReceipt = null;
  const file = $("composer-file");
  if (file) file.value = "";
  $("composer-attachment-name").textContent = "";
  $("composer-attachment-remove").style.display = "none";
  $("composer-attach").textContent = "Attach receipt photo";
}

// The first message creates the conversation, then the photo follows as its own message.
async function sendWithReceipt(body, file) {
  let startedHere = false;
  if (!state.active.id) {
    const started = await startConversation(state.active.vendorId, body);
    if (!started.ok) return started;
    adoptConversation(started.data.conversationId);
    $("composer-input").value = ""; // already sent; a retry must not repeat it
    startedHere = true;
  }

  const prepared = await prepareImage(file);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const uploaded = await uploadReceipt(prepared.file);
  if (!uploaded.ok) return uploaded;
  return sendReceipt(state.active.id, startedHere ? RECEIPT_CAPTION : body, uploaded.path);
}

// A brand-new conversation now exists: remember it and start listening for replies.
function adoptConversation(conversationId) {
  state.active.id = conversationId;
  history.replaceState({}, "", `messages.html?c=${encodeURIComponent(conversationId)}${state.mode ? `&as=${encodeURIComponent(state.mode)}` : ""}`);
  startLive(conversationId);
}

function showComposerError(message) {
  const el = $("composer-error");
  el.textContent = message;
  el.style.display = "block";
}

async function onSend(event) {
  event.preventDefault();
  if (state.sending || !state.active) return;

  const input = $("composer-input");
  const file = isSupportChat() ? state.pendingReceipt : null;
  const body = input.value.trim() || (file ? RECEIPT_CAPTION : "");
  $("composer-error").style.display = "none";
  if (!body) return;

  const button = $("composer-send");
  state.sending = true;
  button.disabled = true;
  button.textContent = file ? "Uploading…" : "Sending…";

  const result = file
    ? await sendWithReceipt(body, file)
    : state.active.id
      ? await sendMessage(state.active.id, body)
      : state.active.orderId
        ? await startOrderConversation(state.active.orderId, body)
        : await startConversation(state.active.vendorId, body);

  state.sending = false;
  button.disabled = false;
  button.textContent = "Send";

  if (!result.ok) {
    showComposerError(result.error);
    return;
  }

  input.value = "";
  $("composer-warning").style.display = "none";
  autosize(input);
  if (file) clearReceipt();

  // The first message created the conversation.
  if (!state.active.id) adoptConversation(result.data.conversationId);
  await loadThread();
}

function autosize(input) {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function wire() {
  $("composer").addEventListener("submit", onSend);

  $("composer-attach").addEventListener("click", () => $("composer-file").click());
  $("composer-file").addEventListener("change", (e) => pickReceipt(e.target.files && e.target.files[0]));
  $("composer-attachment-remove").addEventListener("click", clearReceipt);

  const input = $("composer-input");
  input.addEventListener("input", () => {
    autosize(input);
    $("composer-warning").style.display = looksLikePhoneNumber(input.value) ? "block" : "none";
    if (input.value.trim() && state.live) state.live.notifyTyping(); // shows the dots on their screen
  });
  // Same as other chat apps: on a computer Enter sends and Shift+Enter adds a
  // new line. On a phone Enter always adds a new line (there is a Send button).
  const phoneKeyboard = window.matchMedia("(pointer: coarse)");
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const sends = e.ctrlKey || e.metaKey || (!e.shiftKey && !phoneKeyboard.matches);
    if (sends) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  // Coming back to a hidden tab: mark messages that arrived meanwhile as read.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.needsRead) markThreadRead();
  });

  $("thread-back").addEventListener("click", async () => {
    await refreshInbox();
    showInbox();
  });

  $("conversation-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-conversation]");
    if (!btn) return;
    const conversation = state.conversations.find((c) => c.id === btn.dataset.conversation);
    if (conversation) openConversation(conversation);
  });

  $("chat-modes").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    state.mode = btn.dataset.mode || null;
    await refreshInbox();
    showInbox();
  });
}

// Browser notifications are only ever requested when the person taps the button.
function wireNotifyOffer() {
  const offer = $("notify-offer");
  if (!shouldOfferNotifications()) return;
  offer.style.display = "block";

  $("notify-yes").addEventListener("click", async () => {
    const result = await enableBrowserNotifications();
    if (result !== "granted") dismissNotificationOffer();
    offer.style.display = "none";
  });
  $("notify-no").addEventListener("click", () => {
    dismissNotificationOffer();
    offer.style.display = "none";
  });
}

// "Contact Vendor" on a product opens the chat with a first line ready, so the
// vendor knows which product or service the customer means. The name comes
// from the catalog (never from the address bar), and nothing is sent until
// the customer presses Send.
// A question the shopper asked Ask Item cart AI and chose to send to the vendor.
// It travels in sessionStorage (never in the address bar), is only used if it
// is about THIS product and recent, and is used once. It is only ever put in the
// message box as text; the shopper reads it and presses Send themselves.
function takeHandoffQuestion(productId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem("item_cart_ask_handoff") || "null");
    sessionStorage.removeItem("item_cart_ask_handoff");
    if (!saved || saved.productId !== productId || Date.now() - Number(saved.at) > 10 * 60 * 1000) return "";
    return typeof saved.question === "string" ? saved.question.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  } catch (_) {
    return "";
  }
}

function prefillAboutProduct(productId, vendorId) {
  const product = productId ? getProductById(productId) : null;
  const input = $("composer-input");
  if (!product || product.vendorId !== vendorId || !input || input.value) return;
  const question = takeHandoffQuestion(product.id);
  input.value = question ? `Hi, about the "${product.name}": ${question}` : `Hi, I'd like to ask about "${product.name}".`;
  input.dispatchEvent(new Event("input"));
}
