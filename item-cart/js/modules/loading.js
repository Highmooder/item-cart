// WHAT: removes the "Loading..." placeholder a page ships with.
// WHY: pages such as product, cart and checkout show their real content only
// once the catalog has loaded. Until then the HTML shows a spinner marked
// data-page-loading; each page calls finishLoading() the moment it is ready.
// Safe to call more than once.
export function finishLoading() {
  document.querySelectorAll("[data-page-loading]").forEach((el) => el.remove());
}
