// =====================================================================
// Ask Item cart AI — the launcher button.
// =====================================================================
// WHAT: adds a small "Ask Item cart AI" button to the page. That is ALL that
//       loads with the page.
// WHY:  the chat panel, its styles, the search code and the AI call are
//       downloaded only when someone taps the button. A visitor who never
//       taps it never downloads (or waits for) any of it.
// HOW:  the button is created when the browser is idle, and askPanel.js is
//       fetched with import() on the first tap.
// FUTURE: add this one line to any page that should have the button:
//       import "../modules/askLauncher.js";
// =====================================================================

const STYLE = `
.ask-launcher{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:40;display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:0 18px;border:0;border-radius:999px;background:#1F6F4A;color:#fff;font:600 0.9375rem/1 'Inter','Segoe UI',sans-serif;box-shadow:0 6px 20px rgba(19,61,41,.35);cursor:pointer}
.ask-launcher:hover{background:#133D29}
.ask-launcher:focus-visible{outline:3px solid #E2601F;outline-offset:3px}
.ask-launcher[disabled]{opacity:.75;cursor:progress}
.ask-launcher svg{width:18px;height:18px;flex:none}
.ask-launcher[hidden]{display:none}
`;

const SPARKLE =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 12l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z"/></svg>';

let button = null;
let panelModule = null;

function setLabel(text) {
  button.querySelector("span").textContent = text;
}

async function openPanel() {
  if (button.disabled) return;
  button.disabled = true;
  setLabel("Opening…");
  try {
    // First tap downloads the panel; later taps reuse it.
    panelModule = panelModule || (await import("./askPanel.js"));
    await panelModule.openPanel({
      onClose: () => {
        button.hidden = false;
        button.focus();
      },
    });
    button.hidden = true;
  } catch (error) {
    console.warn("Item cart: could not open Ask Item cart AI.", error);
    panelModule = null; // try the download again next time
    setLabel("Couldn't open. Tap to retry");
    button.disabled = false;
    return;
  }
  setLabel("Ask Item cart AI");
  button.disabled = false;
}

function mount() {
  if (document.getElementById("ask-launcher")) return;

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  button = document.createElement("button");
  button.id = "ask-launcher";
  button.type = "button";
  button.className = "ask-launcher";
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `${SPARKLE}<span>Ask Item cart AI</span>`;
  button.addEventListener("click", openPanel);
  document.body.appendChild(button);
}

// Wait until the page has finished its own work, so the button never competes with it.
function whenIdle(fn) {
  if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 300);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => whenIdle(mount));
else whenIdle(mount);
