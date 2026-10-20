// =====================================================================
// ITEM CART SERVICE WORKER
// =====================================================================
// WHAT: the small helper that makes Item cart installable like an app, and
//       shows a friendly "You're offline" page instead of the browser's
//       error page when the connection drops.
//
// WHAT IT STORES: only Item cart's OWN pages, styles and scripts, so a page
//       you opened before can still appear when the signal is bad.
//       It never touches Supabase, Paystack, fonts or any other website,
//       and it never stores accounts, orders or messages.
//
// HOW IT DECIDES: "network first". When you are online you always get the
//       newest page (so a deploy shows up immediately). The saved copy is
//       only used when the network fails or takes longer than 4 seconds.
//
// UPDATING: this file is always re-checked by the browser. Change VERSION
//       only if you want every phone to throw away its saved copies.
// =====================================================================

const VERSION = "item-cart-v2";
const SLOW_NETWORK_MS = 4000;

// Saved on install so the offline page itself always works.
const PRECACHE = [
  "/offline.html",
  "/css/variables.css",
  "/css/base.css",
  "/css/transitions.css",
  "/css/components.css",
  "/assets/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // One missing file must not stop the install, so each is added separately.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => (name.startsWith("item-cart-") || name.startsWith("runnit-")) && name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // orders, messages and sign-in are never touched

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, Paystack, fonts, esm.sh: not ours
  if (url.pathname.startsWith("/.netlify/")) return; // server functions
  if (url.pathname === "/sw.js" || url.pathname === "/admin.html" || url.pathname === "/admin") return;
  if (request.headers.has("range")) return;

  event.respondWith(request.mode === "navigate" ? handlePage(request, url, event) : handleAsset(request, event));
});

// A page: one saved copy per page, whatever the ?query (messages.html?c=… and
// messages.html share it). If nothing is saved and there's no network: offline page.
async function handlePage(request, url, event) {
  const response = await networkFirst(request, url.origin + url.pathname, event);
  if (response) return response;
  const cache = await caches.open(VERSION);
  return (await cache.match("/offline.html")) || Response.error();
}

async function handleAsset(request, event) {
  return (await networkFirst(request, request.url, event)) || Response.error();
}

// Fresh from the network when it answers; otherwise the saved copy.
// Returns null if the network failed and nothing was saved.
async function networkFirst(request, key, event) {
  const cache = await caches.open(VERSION);
  const saved = await cache.match(key);

  const network = fetch(request).then((response) => {
    // Only plain successful answers are saved (not errors, not redirects).
    if (response.ok && response.type === "basic" && !response.redirected) cache.put(key, response.clone());
    return response;
  });

  if (!saved) {
    try {
      return await network;
    } catch (error) {
      return null;
    }
  }

  // A saved copy exists: never make someone wait on a bad connection.
  event.waitUntil(network.catch(() => {})); // let the network finish and refresh the copy
  return Promise.race([network.catch(() => saved), wait(SLOW_NETWORK_MS).then(() => saved)]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tapping a message alert opens (or focuses) Item cart on that chat.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/messages.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        try {
          await client.navigate(target);
          return client.focus();
        } catch (error) {
          /* this window can't be steered: open a new one below */
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
