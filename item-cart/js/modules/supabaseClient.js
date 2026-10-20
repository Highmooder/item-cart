import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../data/supabaseConfig.js";
import { isBackendConfigured } from "./backend.js";

// WHAT: one shared Supabase client for the whole frontend.
// WHY: every page gets it through backend.js → getSupabase(), so the
// connection settings live in exactly one place.

export const isSupabaseConfigured = isBackendConfigured;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
