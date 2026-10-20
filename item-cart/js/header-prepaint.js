// WHAT: paints the header the instant the page starts, using the copy
// layout.js saved on an earlier page, so there is no blank bar while the
// modules download.
// WHY: layout.js builds the header with JavaScript, which runs a moment
// after the page appears. Showing the saved copy first removes that flash.
// layout.js replaces it with the real header as soon as it runs.
// This is a normal (non-module) script on purpose: it must run immediately.
(function () {
  try {
    var header = document.getElementById("site-header");
    if (!header) return;
    // Keep this page-name rule identical to cacheHeader() in layout.js.
    var page = location.pathname.split("/").pop().replace(/\.html$/, "") || "index";
    var html = sessionStorage.getItem("item_cart_header_" + page) || sessionStorage.getItem("item_cart_header_last");
    if (html) header.innerHTML = html;
  } catch (e) {
    /* storage unavailable: the header just appears a moment later, as before */
  }
})();
