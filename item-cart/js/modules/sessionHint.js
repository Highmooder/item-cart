// WHAT: a very cheap "might this visitor be signed in?" check.
// WHY: supabase-js keeps the login in localStorage under
// sb-<project>-auth-token. Looking for that key costs nothing, so pages
// can skip loading any sign-in-only code (like unread-message alerts)
// for visitors who aren't signed in. It is only a hint — the real check
// is still done with Supabase before anything is shown.

export function hasStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && /^sb-.+-auth-token$/.test(key)) return true;
    }
  } catch (error) {
    /* storage unavailable (e.g. private mode) */
  }
  return false;
}
