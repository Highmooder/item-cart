import { icon } from "./icons.js";

// WHAT: makes Item cart installable like an app.
//   1. Registers the service worker (/sw.js).
//   2. Shows an "Install app" row in the phone menu and the footer, but only
//      when the browser says Item cart can be installed (Android/desktop Chrome,
//      Edge...), or on iPhone/iPad where we show the "Add to Home Screen" steps.
//   3. Hides all of it once Item cart is already running as an installed app.
// WHY: browsers hide "install" in a menu most people never open. A visible
// button is what turns "it can be installed" into "people install it".
// The rows are built in layout.js (marked data-install-item / data-install).

let installPrompt = null; // the browser's install prompt, saved until the person taps our button
let started = false;

function isInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIosDevice() {
  const iPadOnMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1; // newer iPads look like Macs
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || iPadOnMac;
}

export function startPwa() {
  if (started) return;
  started = true;

  registerServiceWorker();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // we offer our own button instead of the browser's small bar
    installPrompt = event;
    refreshInstallRows();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    refreshInstallRows();
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-install]");
    if (!button) return;
    event.preventDefault();
    install();
  });

  // The header and footer are built one after the other, so wait a tick for both.
  setTimeout(refreshInstallRows, 0);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return; // needs https (or localhost)
  const register = () =>
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Item cart: offline support unavailable.", error));
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

function refreshInstallRows() {
  const available = !isInstalledApp() && (installPrompt !== null || isIosDevice());
  document.querySelectorAll("[data-install-item]").forEach((row) => {
    row.hidden = !available;
  });
}

async function install() {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null; // a prompt can only be used once
    prompt.prompt();
    try {
      await prompt.userChoice;
    } catch (error) {
      /* closed without choosing */
    }
    refreshInstallRows();
    return;
  }
  if (isIosDevice()) showIosSteps();
}

// iPhone and iPad can't be asked to install; the person has to do it from the Share menu.
function showIosSteps() {
  let dialog = document.getElementById("install-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "install-dialog";
    dialog.className = "install-dialog";
    dialog.setAttribute("aria-labelledby", "install-dialog-title");
    dialog.innerHTML = `
      <h2 id="install-dialog-title">Install Item cart</h2>
      <ol>
        <li>Tap the <strong>Share</strong> button <span class="install-dialog__icon">${icon("share")}</span> in your browser.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong>. Item cart now opens like an app.</li>
      </ol>
      <button type="button" class="btn btn-primary" data-close-install>Got it</button>`;
    dialog.querySelector("[data-close-install]").addEventListener("click", () => dialog.close());
    document.body.appendChild(dialog);
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
}
