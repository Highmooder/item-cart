import { icon } from "./icons.js";
import { escapeHtml } from "./escape.js";
import { hasStoredSession } from "./sessionHint.js";
import { getCartCount } from "./cart.js";
import { startPwa } from "./pwa.js";

// WHAT: the header and footer are built once here and injected into
// every page's <header id="site-header"> / <footer id="site-footer">.
// WHY: avoids maintaining identical nav/footer markup by hand across
// 9 HTML files — a nav link or footer column only changes in one place.
// The profile icon links to account.html, which shows sign in / create
// account when signed out and order history when signed in.

const NAV_LINKS = [
  { label: "Home", href: "index.html" },
  { label: "Marketplace", href: "marketplace.html" },
  { label: "Vendors", href: "vendors.html" },
  { label: "Messages", href: "messages.html" },
  { label: "Become a Vendor", href: "become-vendor.html" },
];

export function renderHeader(activeHref) {
  const header = document.getElementById("site-header");
  if (!header) return;

  ensureSkipLink();

  // The unread-messages badge lives on this icon (not on Account). Only for
  // people who look signed in; notifications.js fills in the number and sends
  // the icon straight to the unread chat.
  const messagesButton = hasStoredSession()
    ? `<a class="icon-btn" href="messages.html" id="messages-link" aria-label="Messages"${activeHref === "messages.html" ? ' aria-current="page"' : ""}>
          ${icon("message")}
          <span class="cart-count" id="messages-badge" hidden>0</span>
        </a>`
    : "";

  header.innerHTML = `
    <div class="container nav-bar">
      <a href="index.html" class="logo">Item <span>cart</span></a>

      <nav aria-label="Primary">
        <ul class="nav-links" id="nav-links">
          ${NAV_LINKS.map(
            (link) => `<li><a href="${escapeHtml(link.href)}" ${link.href === activeHref ? 'aria-current="page"' : ""}>${escapeHtml(link.label)}</a></li>`
          ).join("")}
          <li class="nav-install" data-install-item hidden><a href="#" data-install role="button">Install app</a></li>
        </ul>
      </nav>

      <div class="nav-actions">
        <a class="icon-btn nav-search" href="marketplace.html" aria-label="Search the marketplace">${icon("search")}</a>
        <a class="icon-btn" href="cart.html" aria-label="View cart">
          ${icon("cart")}
          <span class="cart-count" id="cart-count" hidden>0</span>
        </a>
        ${messagesButton}
        <a class="icon-btn" href="account.html" aria-label="Account"${activeHref === "account.html" ? ' aria-current="page"' : ""}>
          ${icon("user")}
        </a>
        <button type="button" class="nav-toggle" id="nav-toggle" aria-label="Open menu" aria-expanded="false">
          ${icon("menu")}
        </button>
      </div>
    </div>
  `;

  cacheHeader(header);
  wireMobileNav(header);
  startMessageAlerts();
  wireCartBadge(header);
  startPwa();
}

// WHAT: saves the finished header so js/header-prepaint.js can show it
// instantly on the next page, before this file has even loaded.
// The page-name rule must match the one in header-prepaint.js.
function cacheHeader(header) {
  try {
    const page = location.pathname.split("/").pop().replace(/\.html$/, "") || "index";
    sessionStorage.setItem("item_cart_header_" + page, header.innerHTML);
    // Fallback for a page not visited yet this session (no "current page" mark).
    sessionStorage.setItem("item_cart_header_last", header.innerHTML.replace(/ aria-current="page"/g, ""));
  } catch (error) {
    /* storage unavailable: skip, the header still renders normally */
  }
}

// A keyboard user shouldn't have to tab through the full nav on every
// page just to reach the content — this is the first focusable
// element in the document, before the header, on every page (every
// page's <main> already has id="main-content").
function ensureSkipLink() {
  if (document.querySelector(".skip-link")) return;
  const link = document.createElement("a");
  link.className = "skip-link";
  link.href = "#main-content";
  link.textContent = "Skip to main content";
  document.body.insertBefore(link, document.body.firstChild);
}

function wireCartBadge(header) {
  const badge = header.querySelector("#cart-count");
  if (!badge) return;

  function update() {
    const count = getCartCount();
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  update();
  // Fires from cart.js on every add/update/remove, and lets the badge
  // update instantly without a page reload.
  window.addEventListener("item-cart:cart-updated", update);
  // Keeps the badge in sync if the cart changes in another tab.
  window.addEventListener("storage", (event) => {
    if (event.key === "item_cart") update();
  });
}

function wireMobileNav(header) {
  const toggle = header.querySelector("#nav-toggle");
  const links = header.querySelector("#nav-links");
  if (!toggle || !links) return;

  const setOpen = (isOpen) => {
    links.classList.toggle("is-open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
    toggle.innerHTML = isOpen ? icon("close") : icon("menu");
  };

  toggle.addEventListener("click", () => setOpen(!links.classList.contains("is-open")));

  // Tapping anywhere outside the menu, or pressing Escape, closes it.
  document.addEventListener("click", (event) => {
    // composedPath() is read at the moment of the tap, so it still includes the
    // header even though the toggle's icon was just swapped out of the page.
    if (links.classList.contains("is-open") && !event.composedPath().includes(header)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && links.classList.contains("is-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
}

export function renderFooter() {
  const footer = document.getElementById("site-footer");
  if (!footer) return;

  const year = new Date().getFullYear();

  footer.innerHTML = `
    <div class="container">
      <div class="footer-grid">
        <div class="footer-col">
          <a href="index.html" class="logo">Item <span>cart</span></a>
          <p>Find it. Order it. Item cart. &mdash; a marketplace connecting students with vendors around their campus.</p>
        </div>
        <div class="footer-col">
          <h4>Explore</h4>
          <ul>
            <li><a href="index.html">Home</a></li>
            <li><a href="marketplace.html">Marketplace</a></li>
            <li><a href="vendors.html">Vendors</a></li>
            <li data-install-item hidden><a href="#" data-install role="button">Install the app</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>For Vendors</h4>
          <ul>
            <li><a href="become-vendor.html">Become a Vendor</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <span>&copy; ${year} Item cart. All rights reserved.</span>
        <span class="footer-legal"><a href="privacy.html">Privacy Policy</a><a href="terms.html">Terms of Service</a></span>
        <span>Currently serving UNIOSUN students.</span>
      </div>
    </div>
  `;
}

// Signed-in visitors get an unread-message badge. It is loaded on demand,
// so signed-out visitors never download any of it.
function startMessageAlerts() {
  if (!hasStoredSession()) return;
  import("./notifications.js")
    .then((module) => module.startNotifications())
    .catch((error) => console.warn("Item cart: message alerts unavailable.", error));
}
