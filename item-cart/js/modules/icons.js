// Minimal hand-picked line-icon set as inline SVG markup strings.
// WHAT: one small icon library instead of an external icon font.
// WHY: keeps the project dependency-free and each icon lightweight.
// FUTURE: swap any path here without touching component markup.

export const icons = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  cart: '<svg viewBox="0 0 24 24"><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 3h2l2.6 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
  close: '<svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.7 1.5 6.8L12 17l-6.1 3.5 1.5-6.8L2.2 9l6.9-.7z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24"><path d="M4 20l1.4-4.2A8 8 0 1 1 9 18.6z"/><path d="M9 10a1 1 0 0 0 1 1c1 2 2 3 4 4a1 1 0 0 0 1-1l.6-1.2a1 1 0 0 1 1-.5l2 .4a1 1 0 0 1 .8 1c-.2 2-2 3.3-4 3.3-4 0-8-4-8-8 0-2 1.3-3.8 3.3-4a1 1 0 0 1 1 .8l.4 2a1 1 0 0 1-.3.9z"/></svg>',
  food: '<svg viewBox="0 0 24 24"><path d="M6 2v7a2 2 0 0 0 4 0V2"/><path d="M8 9v13"/><path d="M18 2c-2 0-3 2-3 5s1 4 3 4v9"/></svg>',
  fashion: '<svg viewBox="0 0 24 24"><path d="M8 4l4 3 4-3 4 4-3 3v10H7V11L4 8z"/></svg>',
  electronics: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="14" rx="2"/><line x1="9" y1="21" x2="15" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  beauty: '<svg viewBox="0 0 24 24"><path d="M10 3h4v4l2 2v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9l2-2z"/></svg>',
  academic: '<svg viewBox="0 0 24 24"><path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/></svg>',
  accessories: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="5"/><path d="M9 13l-2 8 5-3 5 3-2-8"/></svg>',
  hostel: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
  services: '<svg viewBox="0 0 24 24"><path d="M14 4a4 4 0 1 0 4 4"/><path d="M3 21l6-6 3 3-6 6z"/><path d="M14 8l6 6"/></svg>',
  others: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
  location: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.3 7-12a7 7 0 0 0-14 0c0 5.7 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  verified: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 1.8 2.9-.4 1.1 2.7 2.7 1.1-.4 2.9L22 12l-1.8 2.4.4 2.9-2.7 1.1-1.1 2.7-2.9-.4L12 22l-2.4-1.8-2.9.4-1.1-2.7-2.7-1.1.4-2.9L2 12l1.8-2.4-.4-2.9 2.7-1.1 1.1-2.7 2.9.4z"/><path d="M8.5 12.5l2.2 2.2 4.3-4.8"/></svg>',
  message: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 11v9h14v-9"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>',
  checkDouble: '<svg viewBox="0 0 24 24"><path d="M2 13l4 4L15 8"/><path d="M10 16l1 1L22 7"/></svg>',
};

export function icon(name) {
  const markup = icons[name];
  if (!markup) return "";
  // All icons here are decorative — every usage site either sits next
  // to descriptive text or has aria-label on the interactive parent —
  // so hiding them from screen readers avoids redundant announcements.
  return markup.replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
}
