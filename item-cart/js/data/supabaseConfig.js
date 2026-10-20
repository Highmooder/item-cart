// Supabase connection settings.
// WHAT: the project URL and the public "anon" key.
// WHY: the anon key is SAFE to expose in the browser — the database's
// Row Level Security rules (01_schema.sql / 03_admin_catalog.sql)
// decide what it can do. NEVER put the "service_role" key here.
// WHERE: Supabase dashboard → Project Settings → API.

export const SUPABASE_URL = "https://qgcxbyghgrxksmgojbky.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnY3hieWdoZ3J4a3NtZ29qYmt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0Nzc2OTYsImV4cCI6MjEwODA1MzY5Nn0.4Jf2BJ-PjhSJ1d7e0rzwKsdYYhgUS7x4-cOw8PfvJFo";
