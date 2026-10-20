import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../data/supabaseConfig.js";

// WHAT: tells the storefront whether Supabase has been set up, and loads
// the Supabase client only when it's needed.
// WHY: the client comes from a CDN. Loading it lazily means the shop still
// opens (with the built-in sample catalog) if the keys aren't pasted in
// yet or the CDN can't be reached — instead of a blank page.
// FUTURE: when you self-host the Supabase library, only getSupabase()
// changes.

export const isBackendConfigured =
  !SUPABASE_URL.includes("YOUR-PROJECT-REF") && !SUPABASE_ANON_KEY.includes("YOUR-ANON");

export async function getSupabase() {
  return (await import("./supabaseClient.js")).supabase;
}
